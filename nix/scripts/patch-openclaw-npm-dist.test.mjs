import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

const script = path.join(import.meta.dirname, "patch-openclaw-npm-dist.mjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dist-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    path.join(dist, "paths-BMBAvkNf.js"),
    'export function p(env) { return env?.OPENCLAW_NIX_MODE === "1"; }\n',
  );
  fs.writeFileSync(
    path.join(dist, "path-DILYn_gk.js"),
    "export function f(value) { return value; }\n",
  );
  fs.writeFileSync(
    path.join(dist, "hardlink-policy-EgX5ySNS.js"),
    `import { p as resolveIsNixMode } from "./paths-BMBAvkNf.js";
import { f as safeRealpathSync } from "./path-DILYn_gk.js";
import path from "node:path";
const NIX_STORE_ROOT = "/nix/store";
function isNixStorePluginRoot(rootDir, realpathCache) {
\tconst rootRealPath = safeRealpathSync(rootDir, realpathCache) ?? path.resolve(rootDir);
\treturn rootRealPath === NIX_STORE_ROOT || rootRealPath.startsWith(\`\${NIX_STORE_ROOT}/\`);
}
function shouldRejectHardlinkedPluginFiles(params) {
\tif (params.origin === "bundled") return false;
\tif (resolveIsNixMode(params.env) && isNixStorePluginRoot(params.rootDir, params.realpathCache)) return false;
\treturn true;
}
export { shouldRejectHardlinkedPluginFiles as t };
`,
  );
  const discoveryPath = path.join(dist, "discovery-7zi_zNvu.js");
  fs.writeFileSync(
    discoveryPath,
    `import { f as safeRealpathSync } from "./path-DILYn_gk.js";
import path from "node:path";
import { t as shouldRejectHardlinkedPluginFiles } from "./hardlink-policy-EgX5ySNS.js";
function currentUid(uid) {
	return uid;
}
function checkPathStatAndPermissions(params) {
	const stat = { uid: 65534 };
	if (params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0) return { reason: "path_suspicious_ownership" };
	return null;
}
function findCandidateBlockIssue(params) {
	return checkPathStatAndPermissions({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		uid: currentUid(params.ownershipUid)
	});
}
function isUnsafePluginCandidate(params) {
	const issue = findCandidateBlockIssue({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	});
	return Boolean(issue);
}
function addCandidate(params) {
	if (isUnsafePluginCandidate({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	})) return;
	params.candidates.push(params.source);
}
function discoverOpenClawPlugins(params = {}) {
	const candidates = [];
	addCandidate({
		candidates,
		source: "/nix/store/fake-openclaw-runtime-plugin/index.js",
		rootDir: "/nix/store/fake-openclaw-runtime-plugin",
		origin: "config",
		ownershipUid: 1000,
		realpathCache: new Map()
	});
	return { candidates, diagnostics: [] };
}
export { discoverOpenClawPlugins };
`,
  );
  const missingInstallPath = path.join(dist, "missing-configured-plugin-install-jsvFew4a.js");
  fs.writeFileSync(
    missingInstallPath,
    `function collectDownloadableInstallCandidates() {
\treturn [];
}
async function repairMissingPluginInstalls(params) {
\tconst env = params.env ?? process.env;
\tconst warnings = [];
\tfor (const candidate of collectDownloadableInstallCandidates({
\t\tcfg: params.cfg,
\t\tenv,
\t})) {
\t\twarnings.push(\`Failed to install missing configured plugin "\${candidate.pluginId}" from \${candidate.npmSpec}: nope\`);
\t}
\tfor (const candidate of collectDownloadableInstallCandidates({
\t\tcfg: params.fallbackCfg,
\t\tenv,
\t})) {
\t\twarnings.push(\`Failed to install missing configured plugin "\${candidate.pluginId}" from \${candidate.npmSpec}: nope\`);
\t}
\treturn { warnings };
}
export { repairMissingPluginInstalls };
`,
  );
  const manifestRegistryPath = path.join(dist, "manifest-registry-D1GWNOpI.js");
  fs.writeFileSync(
    manifestRegistryPath,
    `import { f as safeRealpathSync } from "./path-DILYn_gk.js";
import { m as resolveUserPath } from "./utils-CRO4LGEB.js";
import { s as getOfficialExternalPluginCatalogEntryForPackage, v as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-Dxs5EUfF.js";
import fs from "node:fs";
import path from "node:path";
function isTrustedOfficialPluginInstall(params) {
	return false;
}
export { isTrustedOfficialPluginInstall };
`,
  );
  const installRecordReaderPath = path.join(
    dist,
    "installed-plugin-index-record-reader-CrcykudU.js",
  );
  fs.writeFileSync(
    installRecordReaderPath,
    `async function loadInstalledPluginIndexInstallRecords(params = {}) {
\treturn { stale: { source: "npm" } };
}
function loadInstalledPluginIndexInstallRecordsSync(params = {}) {
\treturn { stale: { source: "npm" } };
}
export { loadInstalledPluginIndexInstallRecords, loadInstalledPluginIndexInstallRecordsSync };
`,
  );
  return {
    root,
    discoveryPath,
    missingInstallPath,
    installRecordReaderPath,
    manifestRegistryPath,
  };
}

test("patches Nix-owned plugin discovery and persisted install behavior", async () => {
  const {
    root,
    discoveryPath,
    missingInstallPath,
    installRecordReaderPath,
    manifestRegistryPath,
  } = makeFixture();
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(discoveryPath, "utf8");
  assert.match(patched, /function isTrustedNixStorePluginRoot/);
  assert.match(patched, /OPENCLAW_NIX_MODE === "1"/);
  assert.match(patched, /!isTrustedNixStorePluginRoot\(params\)/);
  const discovery = await import(pathToFileURL(discoveryPath).href);
  assert.deepEqual(
    discovery.discoverOpenClawPlugins({
      env: { OPENCLAW_NIX_MODE: "1" },
    }).candidates,
    ["/nix/store/fake-openclaw-runtime-plugin/index.js"],
  );

  const missingInstallPatched = fs.readFileSync(missingInstallPath, "utf8");
  assert.equal(
    [
      ...missingInstallPatched.matchAll(
        /if \(\(params\.env \?\? process\.env\)\.OPENCLAW_NIX_MODE !== "1"\) for \(const candidate of collectDownloadableInstallCandidates/g,
      ),
    ].length,
    2,
  );
  assert.equal(missingInstallPatched.includes("\n\tfor (const candidate of collectDownloadableInstallCandidates({"), false);

  const recordReader = await import(pathToFileURL(installRecordReaderPath).href);
  const disabledEnv = { OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1" };
  assert.deepEqual(
    await recordReader.loadInstalledPluginIndexInstallRecords({ env: disabledEnv }),
    {},
  );
  assert.deepEqual(recordReader.loadInstalledPluginIndexInstallRecordsSync({ env: disabledEnv }), {});
  assert.deepEqual(
    await recordReader.loadInstalledPluginIndexInstallRecords({
      env: { OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "0" },
    }),
    { stale: { source: "npm" } },
  );

  const manifestRegistry = fs.readFileSync(manifestRegistryPath, "utf8");
  assert.match(manifestRegistry, /function isTrustedOfficialNixRuntimePlugin/);
  assert.match(manifestRegistry, /OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS/);
  assert.match(manifestRegistry, /\.openclaw-nix-runtime-plugin\.json/);
  assert.equal(
    manifestRegistry.includes(
      "function isTrustedOfficialPluginInstall(params) {\n\tif (isTrustedOfficialNixRuntimePlugin(params)) return true;",
    ),
    true,
  );
});
