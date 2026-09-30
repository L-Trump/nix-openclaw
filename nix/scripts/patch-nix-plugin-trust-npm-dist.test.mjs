import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("./patch-nix-plugin-trust-npm-dist.mjs", import.meta.url));
const fixture = {
  "installed-plugin-record-match-fixture.mjs": `import fs from "node:fs";\nimport path from "node:path";\nasync function loadInstalledPluginIndexInstallRecords(params = {}) {\n  return { old: true };\n}\nfunction loadInstalledPluginIndexInstallRecordsSync(params = {}) {\n  return { old: true };\n}\nfunction matchesInstalledPluginRecord(params) { return false; }\nfunction resolvePluginTrust(params) {\n  return { reason: "record-missing" };\n}\nexport { resolvePluginTrust, loadInstalledPluginIndexInstallRecordsSync, loadInstalledPluginIndexInstallRecords };\n`,
  "plugin-registry-snapshot-fixture.mjs": `function loadPluginRegistrySnapshotWithMetadata(params = {}) {\n  const env = params.env ?? process.env;\n  if (!(params.preferPersisted !== false)) { return { source: "derived" }; }\n  return { source: "persisted" };\n}\nexport { loadPluginRegistrySnapshotWithMetadata };\n`,
  "official-external-plugin-catalog-fixture.mjs": `function getOfficialExternalPluginCatalogEntryForPackage(name) { return name === "@openclaw/qwen-provider" ? { id: "qwen" } : undefined; }\nexport { getOfficialExternalPluginCatalogEntryForPackage as i };\n`,
  "official-external-plugin-catalog-source-fixture.mjs": `function resolveOfficialExternalPluginId(entry) { return entry.id; }\nexport { resolveOfficialExternalPluginId as h };\n`,
};

function withDist(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nix-trust-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  try {
    for (const [name, contents] of Object.entries(fixture)) {
      fs.writeFileSync(path.join(dist, name), contents);
    }
    run(root, dist);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function patch(root) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("official Nix runtime trust requires attested exact root", async () => {
  const storePlugin = process.env.OPENCLAW_TEST_OFFICIAL_PLUGIN_ROOT;
  withDist((root, dist) => {
    const result = patch(root);
    assert.equal(result.status, 0, result.stderr);
    const file = path.join(dist, "installed-plugin-record-match-fixture.mjs");
    assert.match(fs.readFileSync(file, "utf8"), /isTrustedNixRuntimePlugin/);
    const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    // Doctor must be able to reread the registry it just persisted in Nix mode.
    const registry = fs.readFileSync(path.join(dist, "plugin-registry-snapshot-fixture.mjs"), "utf8");
    assert.equal(registry, fixture["plugin-registry-snapshot-fixture.mjs"]);
  });
  if (storePlugin) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nix-trust-runtime-"));
    try {
      const dist = path.join(root, "dist");
      fs.mkdirSync(dist);
      for (const [name, contents] of Object.entries(fixture)) {
        fs.writeFileSync(path.join(dist, name), contents);
      }
      assert.equal(patch(root).status, 0);
      const { resolvePluginTrust, loadInstalledPluginIndexInstallRecordsSync, loadInstalledPluginIndexInstallRecords } = await import(pathToFileURL(path.join(dist, "installed-plugin-record-match-fixture.mjs")).href);
      const { loadPluginRegistrySnapshotWithMetadata } = await import(pathToFileURL(path.join(dist, "plugin-registry-snapshot-fixture.mjs")).href);
      const packageJson = JSON.parse(fs.readFileSync(path.join(storePlugin, "package.json"), "utf8"));
      const params = {
        pluginId: "qwen",
        candidate: { origin: "config", rootDir: storePlugin, packageName: packageJson.name, packageVersion: packageJson.version },
        installRecords: {},
        registryPath: "fixture",
      };
      const trust = (env) => resolvePluginTrust({ ...params, env }).reason;
      assert.equal(trust({ OPENCLAW_NIX_MODE: "1", OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS: storePlugin }), "trusted-official");
      assert.equal(trust({ OPENCLAW_NIX_MODE: "1" }), "record-missing");
      assert.equal(trust({ OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS: storePlugin }), "record-missing");
      assert.equal(resolvePluginTrust({ ...params, pluginId: "fake", env: { OPENCLAW_NIX_MODE: "1", OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS: storePlugin } }).reason, "record-missing");
      const managedEnv = { OPENCLAW_NIX_MODE: "1", OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS: storePlugin };
      assert.deepEqual(loadInstalledPluginIndexInstallRecordsSync({ env: managedEnv }), {});
      assert.deepEqual(await loadInstalledPluginIndexInstallRecords({ env: managedEnv }), {});
      assert.deepEqual(loadInstalledPluginIndexInstallRecordsSync({ env: {} }), { old: true });
      assert.equal(loadPluginRegistrySnapshotWithMetadata({ env: managedEnv }).source, "persisted");
      assert.equal(loadPluginRegistrySnapshotWithMetadata({ env: {} }).source, "persisted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unexpected dist contract aborts without partial writes", () => {
  withDist((root, dist) => {
    const owner = path.join(dist, "installed-plugin-record-match-fixture.mjs");
    const original = fs.readFileSync(owner, "utf8");
    fs.writeFileSync(path.join(dist, "installed-plugin-record-match-copy.mjs"), original);
    const result = patch(root);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(owner, "utf8"), original);
  });
});
