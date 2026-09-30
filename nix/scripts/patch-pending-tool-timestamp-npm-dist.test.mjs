import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;
const script = path.join(import.meta.dirname, "patch-pending-tool-timestamp-npm-dist.mjs");

test("live pending tool results inherit their assistant timestamp and retain tool name", { skip: !sourceDist }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pending-timestamp-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const chunks = fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(sourceDist, name), "utf8").includes("function installSessionToolResultGuard(sessionManager, opts)"));
    assert.equal(chunks.length, 1);
    const file = path.join(dist, chunks[0]);
    fs.copyFileSync(path.join(sourceDist, chunks[0]), file);
    fs.chmodSync(file, 0o644);
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /pending\.set\(call\.id, \{ name: call\.name, timestamp: Number\.isFinite\(persistedMessage\.timestamp\)/);
    assert.match(source, /sourceTimestamp: entry\.timestamp/);
    assert.match(source, /toolName: entry\.name/);
    assert.match(source, /pending\.get\(id\)\?\.name/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
