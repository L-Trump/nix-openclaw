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

function replaceInFunction(sourceText, functionName, search, replacement, description) {
  const functionStart = sourceText.indexOf(`function ${functionName}(`);
  if (functionStart === -1) {
    fail(`${description}: function ${functionName} not found`);
  }
  const nextFunction = sourceText.indexOf("\nfunction ", functionStart + 1);
  const functionEnd = nextFunction === -1 ? sourceText.length : nextFunction;
  const before = sourceText.slice(0, functionStart);
  const body = sourceText.slice(functionStart, functionEnd);
  const after = sourceText.slice(functionEnd);
  const count = body.split(search).length - 1;
  if (count === 0 && !body.includes(replacement)) {
    fail(`${description}: expected marker not found`);
  }
  if (count > 1) {
    fail(`${description}: expected at most one marker, found ${count}`);
  }
  return `${before}${body.replace(search, replacement)}${after}`;
}

source = replaceInFunction(
  source,
  "findCandidateBlockIssue",
  `\t\torigin: params.origin,\n\t\tuid: currentUid(params.ownershipUid)`,
  `\t\torigin: params.origin,\n\t\tuid: currentUid(params.ownershipUid),\n\t\tenv: params.env,\n\t\trealpathCache: params.realpathCache`,
  "Nix ownership env propagation into path checks",
);
source = replaceInFunction(
  source,
  "isUnsafePluginCandidate",
  `\t\townershipUid: params.ownershipUid,\n\t\trealpathCache: params.realpathCache`,
  `\t\townershipUid: params.ownershipUid,\n\t\trealpathCache: params.realpathCache,\n\t\tenv: params.env`,
  "Nix ownership env propagation into candidate checks",
);
source = replaceInFunction(
  source,
  "addCandidate",
  `\t\townershipUid: params.ownershipUid,\n\t\trealpathCache: params.realpathCache\n\t}))`,
  `\t\townershipUid: params.ownershipUid,\n\t\trealpathCache: params.realpathCache,\n\t\tenv: params.env\n\t}))`,
  "Nix ownership env propagation into unsafe-candidate checks",
);

function injectEnvIntoAddCandidateCalls(sourceText) {
  let cursor = 0;
  let patched = "";
  let changed = 0;
  while (true) {
    const callStart = sourceText.indexOf("addCandidate({", cursor);
    if (callStart === -1) {
      patched += sourceText.slice(cursor);
      break;
    }
    patched += sourceText.slice(cursor, callStart);
    const braceStart = callStart + "addCandidate(".length;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let index = braceStart;
    for (; index < sourceText.length; index += 1) {
      const char = sourceText[index];
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) {
      fail("unterminated addCandidate object while patching Nix ownership env propagation");
    }
    let call = sourceText.slice(callStart, index);
    if (call.includes("realpathCache: params.realpathCache") && !call.includes("env: params.env")) {
      call = call.replace(
        /(\n\s*)realpathCache: params\.realpathCache(?=\n|$)/,
        "$&,$1env: params.env",
      );
      changed += 1;
    }
    patched += call;
    cursor = index;
  }
  return { source: patched, changed };
}

const addCandidateEnvPatch = injectEnvIntoAddCandidateCalls(source);
source = addCandidateEnvPatch.source;
if (addCandidateEnvPatch.changed === 0 && !source.includes("env: params.env")) {
  fail("OpenClaw discovery chunk did not receive addCandidate env propagation");
}
if (
  !source.includes("uid: currentUid(params.ownershipUid),\n\t\tenv: params.env") ||
  !source.includes("realpathCache: params.realpathCache,\n\t\tenv: params.env")
) {
  fail("OpenClaw discovery chunk did not receive complete Nix ownership env propagation");
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

const manifestRegistryFiles = jsFiles.filter((file) =>
  fs.readFileSync(file, "utf8").includes("function isTrustedOfficialPluginInstall"),
);

if (manifestRegistryFiles.length !== 1) {
  fail(`expected exactly one manifest registry chunk, found ${manifestRegistryFiles.length}`);
}

const manifestRegistryFile = manifestRegistryFiles[0];
let manifestRegistrySource = fs.readFileSync(manifestRegistryFile, "utf8");
const trustedNixRuntimePluginHelper = `const NIX_RUNTIME_PLUGIN_STORE_ROOT = "/nix/store";
const NIX_RUNTIME_PLUGIN_ATTESTATION_FILENAME = ".openclaw-nix-runtime-plugin.json";
function isTrustedOfficialNixRuntimePlugin(params) {
\tif (params.env.OPENCLAW_NIX_MODE !== "1" || params.candidate.origin !== "config") return false;
\tconst packageName = params.candidate.packageName?.trim();
\tif (!packageName) return false;
\tconst catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
\tif (!catalogEntry || resolveOfficialExternalPluginId(catalogEntry) !== params.pluginId) return false;
\tconst rootPath = path.resolve(params.candidate.rootDir);
\tconst rootRealPath = safeRealpathSync(rootPath) ?? rootPath;
\tif (rootRealPath !== NIX_RUNTIME_PLUGIN_STORE_ROOT && !rootRealPath.startsWith(\`\${NIX_RUNTIME_PLUGIN_STORE_ROOT}\${path.sep}\`)) return false;
\tconst trustedRoots = (params.env.OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
\t\tconst resolved = resolveUserPath(entry, params.env);
\t\treturn safeRealpathSync(resolved) ?? path.resolve(resolved);
\t});
\tif (!trustedRoots.includes(rootRealPath)) return false;
\tconst attestationPath = path.join(rootRealPath, NIX_RUNTIME_PLUGIN_ATTESTATION_FILENAME);
\tconst attestationRealPath = safeRealpathSync(attestationPath);
\tif (!attestationRealPath || path.dirname(attestationRealPath) !== rootRealPath) return false;
\ttry {
\t\tconst attestation = JSON.parse(fs.readFileSync(attestationRealPath, "utf8"));
\t\treturn attestation.schemaVersion === 1 && attestation.catalogSource === "official" && attestation.id === params.pluginId && attestation.packageName === packageName && typeof params.candidate.packageVersion === "string" && attestation.version === params.candidate.packageVersion.trim();
\t} catch {
\t\treturn false;
\t}
}
`;
const officialInstallFunction = "function isTrustedOfficialPluginInstall(params) {\n";
const nixTrustedOfficialGuard = "\tif (isTrustedOfficialNixRuntimePlugin(params)) return true;\n";

if (!manifestRegistrySource.includes(trustedNixRuntimePluginHelper)) {
  manifestRegistrySource = manifestRegistrySource.replace(
    officialInstallFunction,
    `${trustedNixRuntimePluginHelper}${officialInstallFunction}`,
  );
}
if (!manifestRegistrySource.includes(`${officialInstallFunction}${nixTrustedOfficialGuard}`)) {
  manifestRegistrySource = manifestRegistrySource.replace(
    officialInstallFunction,
    `${officialInstallFunction}${nixTrustedOfficialGuard}`,
  );
}

if (!manifestRegistrySource.includes(trustedNixRuntimePluginHelper)) {
  fail("manifest registry chunk did not receive the Nix runtime plugin trust helper");
}
if (!manifestRegistrySource.includes(`${officialInstallFunction}${nixTrustedOfficialGuard}`)) {
  fail("manifest registry chunk did not receive the Nix trusted-official guard");
}

fs.writeFileSync(manifestRegistryFile, manifestRegistrySource);
