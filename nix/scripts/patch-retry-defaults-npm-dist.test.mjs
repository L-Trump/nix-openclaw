import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;
const script = path.join(import.meta.dirname, "patch-retry-defaults-npm-dist.mjs");
test("retry defaults are scoped to provider retries and cloud idle; pinned chunks", { skip: !sourceDist }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retry-defaults-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const owners = ["getProviderRetrySettings() {", "function resolveLlmIdleTimeoutMs("].map((marker) => {
      const files = fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") &&
        fs.readFileSync(path.join(sourceDist, name), "utf8").includes(marker));
      assert.equal(files.length, 1);
      const file = path.join(dist, files[0]);
      fs.copyFileSync(path.join(sourceDist, files[0]), file);
      fs.chmodSync(file, 0o644);
      return file;
    });
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const settings = fs.readFileSync(owners[0], "utf8");
    const timeout = fs.readFileSync(owners[1], "utf8");
    assert.equal(settings.split("maxRetries: this.settings.retry?.provider?.maxRetries ?? 4,").length, 2);
    assert.equal(timeout.split("const DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5;").length, 2);
    assert.match(timeout, /const CRON_LLM_IDLE_TIMEOUT_MS = 6e4;/);
    assert.match(timeout, /const CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_MS;/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
