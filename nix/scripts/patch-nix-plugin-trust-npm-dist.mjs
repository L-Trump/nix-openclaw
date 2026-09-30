#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dir = path.join(root, "dist");
const modules = fs.readdirSync(dir).filter((name) => name.endsWith(".mjs"));
const owners = modules.filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes("function resolvePluginTrust(params)"));
if (owners.length !== 1) throw new Error(`expected one plugin trust owner, got ${owners.length}`);
const name = owners[0];
let source = fs.readFileSync(path.join(dir, name), "utf8");
const catalog = modules.filter((name) => name.startsWith("official-external-plugin-catalog-") && fs.readFileSync(path.join(dir, name), "utf8").includes("getOfficialExternalPluginCatalogEntryForPackage as i"));
const catalogSource = modules.filter((name) => name.startsWith("official-external-plugin-catalog-source-") && fs.readFileSync(path.join(dir, name), "utf8").includes("resolveOfficialExternalPluginId as h"));
if (catalog.length !== 1 || catalogSource.length !== 1) throw new Error("official catalog export contract changed");
const marker = "function resolvePluginTrust(params) {\n";
if (source.split(marker).length !== 2 || !source.includes("function matchesInstalledPluginRecord(params)")) throw new Error("plugin trust contract changed");
const imports = `import { i as getOfficialExternalPluginCatalogEntryForPackage } from "./${catalog[0]}";\nimport { h as resolveOfficialExternalPluginId } from "./${catalogSource[0]}";\n`;
const helper = `// Nix-managed official runtime plugins are attested against the selected store root.
function isTrustedNixRuntimePlugin(params) {
  if (params.env.OPENCLAW_NIX_MODE !== "1" || params.candidate.origin !== "config") return false;
  const packageName = params.candidate.packageName;
  const entry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
  if (!entry || resolveOfficialExternalPluginId(entry) !== params.pluginId) return false;
  try {
    const root = fs.realpathSync.native(params.candidate.rootDir);
    if (!/^\\/nix\\/store\\/[a-z0-9]{32}-[^/]+$/.test(root)) return false;
    const roots = (params.env.OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS ?? "").split(path.delimiter).filter(Boolean);
    if (!roots.some((listed) => fs.realpathSync.native(listed) === root)) return false;
    const attestationPath = path.join(root, ".openclaw-nix-runtime-plugin.json");
    if (fs.realpathSync.native(attestationPath) !== attestationPath) return false;
    const attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
    return attestation?.schemaVersion === 1 && attestation.catalogSource === "official" &&
      attestation.id === params.pluginId && attestation.packageName === packageName &&
      typeof params.candidate.packageVersion === "string" &&
      attestation.version === params.candidate.packageVersion;
  } catch { return false; }
}
`;
const asyncRecords = "async function loadInstalledPluginIndexInstallRecords(params = {}) {\n";
const syncRecords = "function loadInstalledPluginIndexInstallRecordsSync(params = {}) {\n";
if (source.split(asyncRecords).length !== 2 || source.split(syncRecords).length !== 2) throw new Error("installed record reader contract changed");
source = `${imports}${source}`
  .replace(marker, `${helper}${marker}\tif (isTrustedNixRuntimePlugin(params)) return { reason: "trusted-official", registryPath: params.registryPath, origin: params.candidate.origin };\n`)
  .replace(asyncRecords, `${asyncRecords}\tif ((params.env ?? process.env).OPENCLAW_NIX_MODE === "1" && (params.env ?? process.env).OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS) return {};\n`)
  .replace(syncRecords, `${syncRecords}\tif ((params.env ?? process.env).OPENCLAW_NIX_MODE === "1" && (params.env ?? process.env).OPENCLAW_NIX_RUNTIME_PLUGIN_ROOTS) return {};\n`);
// Keep upstream's persisted-registry verification: startup migration writes and
// re-reads the registry before recording its checkpoint. Nix-managed legacy
// installation records are still ignored by the reader above.
fs.writeFileSync(path.join(dir, name), source);
