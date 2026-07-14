import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, source) {
  fs.writeFileSync(file, source);
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first === -1) {
    fail(`${label}: source pattern not found`);
  }
  if (source.indexOf(from, first + from.length) !== -1) {
    fail(`${label}: source pattern matched more than once`);
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

function replaceExactCount(source, from, to, expectedCount, label) {
  const parts = source.split(from);
  const count = parts.length - 1;
  if (count !== expectedCount) {
    fail(`${label}: expected ${expectedCount} matches, found ${count}`);
  }
  return parts.join(to);
}

function findSingleDistFile(distDir, filenamePattern, predicate, label) {
  const matches = fs
    .readdirSync(distDir)
    .filter((name) => filenamePattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => predicate(readText(file)));
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one matching dist file, found ${matches.length}`);
  }
  return matches[0];
}

const pluginRoot = process.argv[2] ?? process.env.OPENCLAW_RUNTIME_PLUGIN_ROOT;
if (!pluginRoot) {
  fail("usage: patch-feishu-runtime-plugin-dist.mjs <plugin-root>");
}

const packageJsonPath = path.join(pluginRoot, "package.json");
const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
const distDir = path.join(pluginRoot, "dist");
if (!fs.existsSync(packageJsonPath) || !fs.existsSync(manifestPath) || !fs.existsSync(distDir)) {
  fail(`invalid Feishu runtime plugin root: ${pluginRoot}`);
}

const packageJson = JSON.parse(readText(packageJsonPath));
const manifest = JSON.parse(readText(manifestPath));
if (packageJson.name !== "@openclaw/feishu" || manifest.id !== "feishu") {
  fail(
    `unexpected runtime plugin identity: package=${String(packageJson.name)}, manifest=${String(manifest.id)}`,
  );
}

const replyDispatcherFile = findSingleDistFile(
  distDir,
  /^monitor\.account-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("const queueStreamingUpdate = (nextText, options) =>") &&
    candidate.includes("const closeStreaming = async (options) =>") &&
    candidate.includes("const discardStreamingPreview = async () =>") &&
    (candidate.includes("let partialUpdateQueue = Promise.resolve();") ||
      candidate.includes("const flushStreamingCardUpdate = (combined) => {\n\t\tvoid (async () => {")),
  "Feishu reply dispatcher streaming update chunk",
);
let source = readText(replyDispatcherFile);

const singleOwnerMarker = `\tconst flushStreamingCardUpdate = (combined) => {
\t\tvoid (async () => {`;
if (!source.includes(singleOwnerMarker)) {
  source = replaceOnce(
    source,
    `\tlet partialUpdateQueue = Promise.resolve();\n`,
    ``,
    "Feishu dispatcher FIFO state removal",
  );

  source = replaceOnce(
    source,
    `\tconst flushStreamingCardUpdate = (combined) => {
\t\tpartialUpdateQueue = partialUpdateQueue.then(async () => {
\t\t\tif (streamingStartPromise) await streamingStartPromise;
\t\t\tif (streaming?.isActive()) await streaming.update(combined);
\t\t});
\t};`,
    `\tconst flushStreamingCardUpdate = (combined) => {
\t\tvoid (async () => {
\t\t\tif (streamingStartPromise) await streamingStartPromise;
\t\t\tif (streaming?.isActive()) await streaming.update(combined);
\t\t})().catch((error) => {
\t\t\tparams.runtime.error?.(\`feishu[\${account.accountId}]: streaming update failed: \${String(error)}\`);
\t\t});
\t};`,
    "Feishu dispatcher direct session update replacement",
  );

  source = replaceOnce(
    source,
    `\t\tpartialUpdateQueue = Promise.resolve();\n`,
    ``,
    "Feishu dispatcher FIFO reset removal",
  );

  source = replaceExactCount(
    source,
    `\t\tawait partialUpdateQueue;\n`,
    ``,
    2,
    "Feishu streaming lifecycle FIFO wait removal",
  );
}

if (!source.includes(singleOwnerMarker)) {
  fail("Feishu reply dispatcher did not delegate updates directly to the streaming session");
}
if (!source.includes("if (streaming?.isActive()) await streaming.update(combined);")) {
  fail("Feishu reply dispatcher lost the streaming session update call");
}
if (!source.includes("streaming update failed:")) {
  fail("Feishu reply dispatcher did not retain asynchronous update error logging");
}
if (source.includes("partialUpdateQueue")) {
  fail("Feishu reply dispatcher still contains the unbounded partial update FIFO");
}
if (source.includes("pendingStreamingUpdate") || source.includes("streamingUpdateDrainPromise")) {
  fail("Feishu reply dispatcher contains a second streaming queue owner");
}

writeText(replyDispatcherFile, source);
console.log(`patched Feishu runtime plugin to use its session-owned streaming queue: ${replyDispatcherFile}`);
