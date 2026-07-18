#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  fail("OPENCLAW_PACKAGE_ROOT is required");
}

const distDir = path.join(root, "dist");
if (!fs.existsSync(distDir)) {
  fail(`OpenClaw dist directory missing: ${distDir}`);
}

const jsFiles = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(distDir, name));

const hardlinkPolicyFiles = jsFiles.filter((file) =>
  fs.readFileSync(file, "utf8").includes("function shouldRejectHardlinkedPluginFiles"),
);

if (hardlinkPolicyFiles.length !== 1) {
  fail(`expected exactly one bundled hardlink policy chunk, found ${hardlinkPolicyFiles.length}`);
}

const hardlinkPolicyFile = hardlinkPolicyFiles[0];
const hardlinkSource = fs.readFileSync(hardlinkPolicyFile, "utf8");

const nixStoreHardlinkException =
  "resolveIsNixMode(params.env) && isNixStorePluginRoot(params.rootDir, params.realpathCache)";
if (
  !hardlinkSource.includes(nixStoreHardlinkException) &&
  !hardlinkSource.includes("isTrustedNixStorePluginRoot(params)")
) {
  fail("OpenClaw hardlink policy chunk did not contain the expected Nix store exception");
}

const ownershipCheck =
  'params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0';
const patchedOwnershipCheck =
  'params.origin !== "bundled" && params.uid !== null && !isTrustedNixStorePluginRoot(params) && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0';

const ownershipFiles = jsFiles.filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return source.includes(ownershipCheck) || source.includes(patchedOwnershipCheck);
});

if (ownershipFiles.length !== 1) {
  fail(`expected exactly one bundled ownership policy chunk, found ${ownershipFiles.length}`);
}

const ownershipFile = ownershipFiles[0];
let source = fs.readFileSync(ownershipFile, "utf8");

if (!source.includes(patchedOwnershipCheck)) {
  if (!source.includes(ownershipCheck)) {
    fail("OpenClaw discovery chunk did not contain the expected ownership check");
  }
  if (!source.includes("function isTrustedNixStorePluginRoot")) {
    if (!source.includes("safeRealpathSync") || !source.includes('path from "node:path"')) {
      fail("OpenClaw ownership chunk is missing imports required for the Nix store ownership patch");
    }
    source = source.replace(
      /^(?:import [^\n]+;\n)+/,
      `$&const NIX_STORE_PLUGIN_OWNERSHIP_ROOT = "/nix/store";
function isTrustedNixStorePluginRoot(params) {
\tconst rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache) ?? path.resolve(params.rootDir);
\treturn (params.env ?? process.env).OPENCLAW_NIX_MODE === "1" && (rootRealPath === NIX_STORE_PLUGIN_OWNERSHIP_ROOT || rootRealPath.startsWith(\`\${NIX_STORE_PLUGIN_OWNERSHIP_ROOT}/\`));
}
`,
    );
  }
  source = source.replace(ownershipCheck, patchedOwnershipCheck);
}

if (!source.includes("function isTrustedNixStorePluginRoot")) {
  fail("OpenClaw ownership chunk did not receive the Nix store trust helper");
}
if (!source.includes(patchedOwnershipCheck)) {
  fail("OpenClaw ownership chunk did not receive the Nix store ownership patch");
}

fs.writeFileSync(ownershipFile, source);

const missingConfiguredInstallLoop = "for (const candidate of collectDownloadableInstallCandidates({";
const legacyPatchedMissingConfiguredInstallLoop =
  'if (env.OPENCLAW_NIX_MODE !== "1") for (const candidate of collectDownloadableInstallCandidates({';
const patchedMissingConfiguredInstallLoop =
  'if ((params.env ?? process.env).OPENCLAW_NIX_MODE !== "1") for (const candidate of collectDownloadableInstallCandidates({';

const missingConfiguredInstallFiles = jsFiles.filter((file) => {
  const candidate = fs.readFileSync(file, "utf8");
  return (
    candidate.includes('Failed to install missing configured plugin "') &&
    (candidate.includes(missingConfiguredInstallLoop) || candidate.includes(patchedMissingConfiguredInstallLoop))
  );
});

if (missingConfiguredInstallFiles.length !== 1) {
  fail(`expected exactly one missing configured plugin install chunk, found ${missingConfiguredInstallFiles.length}`);
}

const missingConfiguredInstallFile = missingConfiguredInstallFiles[0];
let missingConfiguredInstallSource = fs.readFileSync(missingConfiguredInstallFile, "utf8");

const normalizedMissingConfiguredInstallSource = missingConfiguredInstallSource.replaceAll(
  legacyPatchedMissingConfiguredInstallLoop,
  missingConfiguredInstallLoop,
);
const missingConfiguredInstallLoopCount =
  normalizedMissingConfiguredInstallSource.split(missingConfiguredInstallLoop).length - 1;
missingConfiguredInstallSource = normalizedMissingConfiguredInstallSource.replaceAll(
  missingConfiguredInstallLoop,
  patchedMissingConfiguredInstallLoop,
);

const patchedMissingConfiguredInstallLoopCount =
  missingConfiguredInstallSource.split(patchedMissingConfiguredInstallLoop).length - 1;
if (missingConfiguredInstallLoopCount === 0) {
  fail("OpenClaw missing configured plugin install chunk did not contain an auto-install candidate loop");
}
if (patchedMissingConfiguredInstallLoopCount !== missingConfiguredInstallLoopCount) {
  fail("OpenClaw missing configured plugin install chunk did not receive the Nix mode auto-install guard");
}
if (missingConfiguredInstallSource.includes(legacyPatchedMissingConfiguredInstallLoop)) {
  fail("OpenClaw missing configured plugin install chunk still has the legacy Nix mode auto-install guard");
}

fs.writeFileSync(missingConfiguredInstallFile, missingConfiguredInstallSource);

const installRecordReaderFiles = jsFiles.filter((file) => {
  const candidate = fs.readFileSync(file, "utf8");
  return (
    candidate.includes("async function loadInstalledPluginIndexInstallRecords(params = {})") &&
    candidate.includes("function loadInstalledPluginIndexInstallRecordsSync(params = {})")
  );
});

if (installRecordReaderFiles.length !== 1) {
  fail(
    `expected exactly one installed plugin record reader chunk, found ${installRecordReaderFiles.length}`,
  );
}

const installRecordReaderFile = installRecordReaderFiles[0];
let installRecordReaderSource = fs.readFileSync(installRecordReaderFile, "utf8");
const disablePersistedRecordsHelper = `const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";
function shouldDisablePersistedPluginInstallRecords(env) {
\tconst value = env[DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV]?.trim().toLowerCase();
\treturn Boolean(value && value !== "0" && value !== "false" && value !== "no");
}
`;
const asyncInstallRecordReader = "async function loadInstalledPluginIndexInstallRecords(params = {}) {\n";
const syncInstallRecordReader = "function loadInstalledPluginIndexInstallRecordsSync(params = {}) {\n";
const disabledRecordsGuard =
  "\tif (shouldDisablePersistedPluginInstallRecords(params.env ?? process.env)) return {};\n";

if (!installRecordReaderSource.includes(disablePersistedRecordsHelper)) {
  installRecordReaderSource = installRecordReaderSource.replace(
    asyncInstallRecordReader,
    `${disablePersistedRecordsHelper}${asyncInstallRecordReader}`,
  );
}
for (const marker of [asyncInstallRecordReader, syncInstallRecordReader]) {
  const patchedMarker = `${marker}${disabledRecordsGuard}`;
  if (!installRecordReaderSource.includes(patchedMarker)) {
    installRecordReaderSource = installRecordReaderSource.replace(marker, patchedMarker);
  }
}

if (!installRecordReaderSource.includes(disablePersistedRecordsHelper)) {
  fail("installed plugin record reader chunk did not receive the disable helper");
}
if (installRecordReaderSource.split(disabledRecordsGuard).length - 1 !== 2) {
  fail("installed plugin record reader chunk did not receive both disable guards");
}

fs.writeFileSync(installRecordReaderFile, installRecordReaderSource);
