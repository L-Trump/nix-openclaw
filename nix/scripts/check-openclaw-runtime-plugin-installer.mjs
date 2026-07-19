import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const installerArg = process.argv[2];
if (!installerArg) {
  throw new Error("usage: check-openclaw-runtime-plugin-installer.mjs <installer>");
}
const installer = path.resolve(installerArg);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-plugin-installer-check-"));
const pluginRoot = path.join(tempRoot, "plugin");
const out = path.join(tempRoot, "out");
const runtimeEntriesFile = path.join(tempRoot, "runtime-entries");
const bundledRootsFile = path.join(tempRoot, "bundled-roots");
const hostRoot = path.join(tempRoot, "host");

fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
fs.mkdirSync(hostRoot, { recursive: true });
fs.writeFileSync(
  path.join(pluginRoot, "package.json"),
  JSON.stringify(
    {
      name: "@openclaw/test-optional-only",
      version: "1.0.0",
      optionalDependencies: {
        "optional-runtime-package": "1.0.0",
      },
      openclaw: {
        runtimeExtensions: ["dist/index.js"],
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(pluginRoot, "openclaw.plugin.json"),
  JSON.stringify({ id: "optional-only", name: "Optional Only" }, null, 2),
);
fs.writeFileSync(path.join(pluginRoot, "dist/index.js"), "export default {};\n");
fs.writeFileSync(runtimeEntriesFile, "dist/index.js\n");
fs.writeFileSync(bundledRootsFile, "");

const result = spawnSync(process.execPath, [installer], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    out,
    OPENCLAW_GATEWAY_PACKAGE: hostRoot,
    OPENCLAW_RUNTIME_PLUGIN_ID: "optional-only",
    OPENCLAW_RUNTIME_PLUGIN_RUNTIME_ENTRIES_FILE: runtimeEntriesFile,
    OPENCLAW_RUNTIME_PLUGIN_BUNDLED_PACKAGE_ROOTS_FILE: bundledRootsFile,
    OPENCLAW_RUNTIME_PLUGIN_DEPENDENCY_MODE: "auto",
  },
  encoding: "utf8",
});

if (result.status === 0) {
  throw new Error("optional-only runtime dependency plugin unexpectedly passed validation");
}

const output = `${result.stdout}\n${result.stderr}`;
if (!output.includes("publish npm-shrinkwrap.json")) {
  throw new Error(`optional-only dependency failure did not explain shrinkwrap requirement:\n${output}`);
}

const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-plugin-alias-check-"));
const aliasPluginRoot = path.join(aliasRoot, "plugin");
const aliasOut = path.join(aliasRoot, "out");
const aliasRuntimeEntriesFile = path.join(aliasRoot, "runtime-entries");
const aliasBundledRootsFile = path.join(aliasRoot, "bundled-roots");

fs.mkdirSync(path.join(aliasPluginRoot, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(aliasPluginRoot, "package.json"),
  JSON.stringify(
    {
      name: "@openclaw/test-runtime-aliases",
      version: "1.0.0",
      openclaw: {
        runtimeExtensions: ["./dist/index.js"],
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(aliasPluginRoot, "openclaw.plugin.json"),
  JSON.stringify({ id: "runtime-aliases", name: "Runtime Aliases" }, null, 2),
);
for (const basename of ["index.js", "register.runtime.js", "runtime-api.js", "setup-api.js"]) {
  fs.writeFileSync(path.join(aliasPluginRoot, "dist", basename), "export default {};\n");
}
fs.writeFileSync(aliasRuntimeEntriesFile, "./dist/index.js\n");
fs.writeFileSync(aliasBundledRootsFile, "");

const aliasResult = spawnSync(process.execPath, [installer], {
  cwd: aliasPluginRoot,
  env: {
    ...process.env,
    out: aliasOut,
    OPENCLAW_RUNTIME_PLUGIN_ID: "runtime-aliases",
    OPENCLAW_RUNTIME_PLUGIN_RUNTIME_ENTRIES_FILE: aliasRuntimeEntriesFile,
    OPENCLAW_RUNTIME_PLUGIN_BUNDLED_PACKAGE_ROOTS_FILE: aliasBundledRootsFile,
    OPENCLAW_RUNTIME_PLUGIN_DEPENDENCY_MODE: "none",
    OPENCLAW_RUNTIME_PLUGIN_LINK_PEER_OPENCLAW: "0",
  },
  encoding: "utf8",
});

if (aliasResult.status !== 0) {
  throw new Error(`runtime alias fixture failed:\n${aliasResult.stdout}\n${aliasResult.stderr}`);
}

for (const basename of ["index.js", "register.runtime.js", "runtime-api.js", "setup-api.js"]) {
  const aliasPath = path.join(aliasOut, basename);
  if (!fs.existsSync(aliasPath)) {
    throw new Error(`runtime alias missing: ${basename}`);
  }
  if (!fs.lstatSync(aliasPath).isSymbolicLink()) {
    throw new Error(`runtime alias is not a symlink: ${basename}`);
  }
}

const attestedRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "openclaw-runtime-plugin-attestation-check-"),
);
const attestedPluginRoot = path.join(attestedRoot, "plugin");
const attestedOut = path.join(attestedRoot, "out");
const attestedRuntimeEntriesFile = path.join(attestedRoot, "runtime-entries");
const attestedBundledRootsFile = path.join(attestedRoot, "bundled-roots");

fs.mkdirSync(path.join(attestedPluginRoot, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(attestedPluginRoot, "package.json"),
  JSON.stringify(
    {
      name: "@openclaw/diagnostics-prometheus",
      version: "2026.7.1",
      openclaw: { runtimeExtensions: ["./dist/index.js"] },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(attestedPluginRoot, "openclaw.plugin.json"),
  JSON.stringify({ id: "diagnostics-prometheus" }, null, 2),
);
fs.writeFileSync(path.join(attestedPluginRoot, "dist/index.js"), "export default {};\n");
fs.writeFileSync(attestedRuntimeEntriesFile, "./dist/index.js\n");
fs.writeFileSync(attestedBundledRootsFile, "");

const attestedResult = spawnSync(process.execPath, [installer], {
  cwd: attestedPluginRoot,
  env: {
    ...process.env,
    out: attestedOut,
    OPENCLAW_RUNTIME_PLUGIN_ID: "diagnostics-prometheus",
    OPENCLAW_RUNTIME_PLUGIN_PACKAGE_NAME: "@openclaw/diagnostics-prometheus",
    OPENCLAW_RUNTIME_PLUGIN_VERSION: "2026.7.1",
    OPENCLAW_RUNTIME_PLUGIN_TRUSTED_OFFICIAL: "1",
    OPENCLAW_RUNTIME_PLUGIN_RUNTIME_ENTRIES_FILE: attestedRuntimeEntriesFile,
    OPENCLAW_RUNTIME_PLUGIN_BUNDLED_PACKAGE_ROOTS_FILE: attestedBundledRootsFile,
    OPENCLAW_RUNTIME_PLUGIN_DEPENDENCY_MODE: "none",
    OPENCLAW_RUNTIME_PLUGIN_LINK_PEER_OPENCLAW: "0",
  },
  encoding: "utf8",
});

if (attestedResult.status !== 0) {
  throw new Error(
    `trusted official runtime fixture failed:
${attestedResult.stdout}
${attestedResult.stderr}`,
  );
}
const attestation = JSON.parse(
  fs.readFileSync(path.join(attestedOut, ".openclaw-nix-runtime-plugin.json"), "utf8"),
);
if (
  attestation.schemaVersion !== 1 ||
  attestation.catalogSource !== "official" ||
  attestation.id !== "diagnostics-prometheus" ||
  attestation.packageName !== "@openclaw/diagnostics-prometheus" ||
  attestation.version !== "2026.7.1"
) {
  throw new Error(`unexpected Nix runtime plugin attestation: ${JSON.stringify(attestation)}`);
}
