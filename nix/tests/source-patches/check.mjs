import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-patch-"));
try {
  fs.mkdirSync(path.join(root, "src/plugins"), { recursive: true });
  for (const name of ["discovery.ts", "hardlink-policy.ts"]) {
    fs.writeFileSync(path.join(root, "src/plugins", name), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, "src/plugins", name)));
  }
  const discoveryPath = path.join(root, "src/plugins/discovery.ts");
  const originalDiscovery = fs.readFileSync(discoveryPath, "utf8");
  const availabilityImport = 'import { inspectPluginLoadPath, pluginPathFailureDiagnostic } from "./discovery-availability.js";\n';
  const beforeAvailabilityImport = originalDiscovery.replace(availabilityImport, "");
  for (const addedImport of ["", availabilityImport]) {
    fs.writeFileSync(discoveryPath, beforeAvailabilityImport.replace(
      'import type { PluginCandidate, PluginDiscoveryResult }',
      `${addedImport}import type { PluginCandidate, PluginDiscoveryResult }`,
    ));
    const probe = spawnSync("patch", ["--dry-run", "--batch", "--fuzz=0", "-p1", "-i", process.env.OWNERSHIP_PATCH], { cwd: root, encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  }
  fs.writeFileSync(discoveryPath, originalDiscovery);
  const patched = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.OWNERSHIP_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(patched.status, 0, patched.stdout + patched.stderr);
  let policy = fs.readFileSync(path.join(root, "src/plugins/hardlink-policy.ts"), "utf8");
  policy = policy.replace(/^import .*;\n/gm, "").replaceAll("export function", "function");
  const discovery = fs.readFileSync(path.join(root, "src/plugins/discovery.ts"), "utf8");
  const start = discovery.indexOf("function checkPathStatAndPermissions(");
  const end = discovery.indexOf("function formatCandidateBlockMessage(", start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(policy + discovery.slice(start, end));
  let stat = { mode: 0o555, uid: 30001 };
  const realpaths = new Map();
  const context = vm.createContext({
    path, process: { platform: "linux" },
    resolveIsNixMode: (env) => env?.OPENCLAW_NIX_MODE === "1",
    pluginCacheRealpathSync: (file) => realpaths.get(file) ?? file,
    pluginCacheStatSync: () => stat,
    currentUid: (uid) => uid,
    checkSourceEscapesRoot: () => null,
    fs: { chmodSync: () => { throw new Error("fixture cannot chmod"); } },
  });
  vm.runInContext(code, context);
  const params = (rootDir, nix) => ({ rootDir, source: `${rootDir}/index.js`, origin: "config", uid: 1000, ownershipUid: 1000, env: { OPENCLAW_NIX_MODE: nix } });
  assert.equal(context.findCandidateBlockIssue(params("/nix/store/plugin", "1")), null);
  assert.equal(context.findCandidateBlockIssue(params("/nix/store/plugin", "0")).reason, "path_suspicious_ownership");
  assert.equal(context.findCandidateBlockIssue(params("/tmp/plugin", "1")).reason, "path_suspicious_ownership");
  assert.equal(context.findCandidateBlockIssue(params("/nix/store-other/plugin", "1")).reason, "path_suspicious_ownership");
  realpaths.set("/nix/store/escaped", "/tmp/plugin");
  assert.equal(context.findCandidateBlockIssue(params("/nix/store/escaped", "1")).reason, "path_suspicious_ownership");
  stat = { mode: 0o777, uid: 30001 };
  assert.equal(context.findCandidateBlockIssue(params("/nix/store/plugin", "1")).reason, "path_world_writable");
  stat = null;
  assert.equal(context.findCandidateBlockIssue(params("/nix/store/plugin", "1")).reason, "path_stat_failed");
  assert.equal(context.shouldRejectHardlinkedPluginFiles(params("/nix/store/plugin", "1")), false);
  assert.equal(context.shouldRejectHardlinkedPluginFiles(params("/tmp/plugin", "1")), true);
  for (const name of ["installed-plugin-record-match.ts", "installed-plugin-index-record-reader.ts", "plugin-registry-snapshot.ts"]) {
    fs.writeFileSync(path.join(root, "src/plugins", name), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, "src/plugins", name)));
  }
  for (const patchFile of [process.env.TRUST_PATCH, process.env.RECORDS_PATCH]) {
    const result = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", patchFile], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const trust = fs.readFileSync(path.join(root, "src/plugins/installed-plugin-record-match.ts"), "utf8");
  const records = fs.readFileSync(path.join(root, "src/plugins/installed-plugin-index-record-reader.ts"), "utf8");
  assert.match(trust, /function isTrustedNixRuntimePlugin/);
  assert.match(records, /function managedNixPluginRegistry/);
  for (const file of ["packages/agent-core/src/harness/session/tool-result-pairing.ts", "src/agents/session-transcript-repair.ts"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, file)));
  }
  const timestampPatch = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.TIMESTAMP_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(timestampPatch.status, 0, timestampPatch.stdout + timestampPatch.stderr);
  const pairing = fs.readFileSync(path.join(root, "packages/agent-core/src/harness/session/tool-result-pairing.ts"), "utf8");
  assert.match(pairing, /Number\.isFinite\(params\.sourceTimestamp\)/);
  const aggregateSourcePath = "src/agents/embedded-agent-runner/tool-result-truncation.ts";
  fs.mkdirSync(path.dirname(path.join(root, aggregateSourcePath)), { recursive: true });
  fs.writeFileSync(path.join(root, aggregateSourcePath), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, aggregateSourcePath)));
  const aggregatePatch = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.AGGREGATE_BUDGET_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(aggregatePatch.status, 0, aggregatePatch.stdout + aggregatePatch.stderr);
  const aggregateSource = fs.readFileSync(path.join(root, aggregateSourcePath), "utf8");
  assert.match(aggregateSource, /contextWindowTokens \* TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE \* AGGREGATE_TOOL_RESULT_CONTEXT_SHARE/);
  assert.match(aggregateSource, /aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO/);
  const transportPath = "src/agents/provider-transport-fetch.ts";
  fs.writeFileSync(path.join(root, transportPath), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, transportPath)));
  const scnetPatch = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.SCNET_RETRY_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(scnetPatch.status, 0, scnetPatch.stdout + scnetPatch.stderr);
  assert.match(fs.readFileSync(path.join(root, transportPath), "utf8"), /!allowScnetHeaderless429 && shouldBypassLongSdkRetry\(response\)/);
  const sessionsSendPath = "src/agents/tools/sessions-send-tool.ts";
  fs.mkdirSync(path.dirname(path.join(root, sessionsSendPath)), { recursive: true });
  fs.writeFileSync(path.join(root, sessionsSendPath), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, sessionsSendPath)));
  const sessionsPatch = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.SESSIONS_SEND_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(sessionsPatch.status, 0, sessionsPatch.stdout + sessionsPatch.stderr);
  const schema = fs.readFileSync(path.join(root, sessionsSendPath), "utf8");
  assert.match(schema, /label: Type.Optional\(Type.String\(\{ minLength: 0/);
  assert.match(schema, /agentId: Type.Optional\(Type.String\(\{ minLength: 0/);
  const pendingGuardPath = "src/agents/session-tool-result-guard.ts";
  fs.writeFileSync(path.join(root, pendingGuardPath), fs.readFileSync(path.join(process.env.OPENCLAW_SOURCE, pendingGuardPath)));
  const pendingPatch = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", process.env.PENDING_TOOL_TIMESTAMP_PATCH], { cwd: root, encoding: "utf8" });
  assert.equal(pendingPatch.status, 0, pendingPatch.stdout + pendingPatch.stderr);
  assert.match(fs.readFileSync(path.join(root, pendingGuardPath), "utf8"), /sourceTimestamp: entry\.timestamp/);
  console.log("pinned source patch application, caller environment, ownership and path guards: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
