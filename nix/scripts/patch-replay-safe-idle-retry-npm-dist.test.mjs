import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;
const script = path.join(import.meta.dirname, "patch-replay-safe-idle-retry-npm-dist.mjs");
test("replay-safe idle retry is bounded, delayed and separate from transient budget", { skip: !sourceDist }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-idle-retry-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const files = fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(sourceDist, name), "utf8").includes("async function recoverEmbeddedRunAttempt(input)"));
    assert.equal(files.length, 1);
    const file = path.join(dist, files[0]);
    fs.copyFileSync(path.join(sourceDist, files[0]), file);
    fs.chmodSync(file, 0o644);
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const patched = fs.readFileSync(file, "utf8");
    assert.equal(spawnSync(process.execPath, ["--check", file]).status, 0);
    assert.match(patched, /if \(timedOut && idleTimedOut && currentAttemptReplaySafe && !hasAttemptTerminalState\(attempt\)/);
    assert.match(patched, /!timedOutByRunBudget && !runtime\.pluginHarnessOwnsTransport/);
    assert.match(patched, /!resolveReplayInvalidForAttempt\(null\) && await failoverRetryController\.retrySilentIdleTimeout\(\)/);
    assert.match(patched, /\(cap=7\)\. Halting further attempts/);
    const left = patched.indexOf("const MAX_OVERLOAD_PROFILE_ROTATIONS = 1;", patched.indexOf("async function recoverEmbeddedRunAttempt(input)"));
    const right = patched.indexOf("//#endregion", left);
    assert.ok(left >= 0 && right > left);
    const delays = [];
    const intervals = [];
    const sandbox = {
      sanitizeForLog: (value) => value,
      sleepWithAbort: async (delay) => { delays.push(delay); },
      log$3: { warn() {} },
      Math: { ...Math, min: Math.min, floor: Math.floor, random: () => 0 },
    };
    vm.createContext(sandbox);
    vm.runInContext(patched.slice(left, right), sandbox);
    const controller = sandbox.createEmbeddedRunFailoverRetryController({
      runParams: { onRetryWait: (deadline) => { intervals.push(deadline); return () => {}; } },
      provider: "test", modelId: "model", fallbackConfigured: true,
    });
    for (let i = 0; i < 5; i++) {
      assert.equal(await controller.retrySilentIdleTimeout(), true);
    }
    assert.equal(await controller.retrySilentIdleTimeout(), false);
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000]);
    assert.equal(intervals.length, 5);
    assert.equal(controller.transientRetryCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
