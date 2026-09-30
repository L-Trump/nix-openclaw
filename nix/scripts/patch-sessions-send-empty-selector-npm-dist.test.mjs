import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(import.meta.dirname, "patch-sessions-send-empty-selector-npm-dist.mjs");
const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;

test("9.5 sessions_send accepts blank optional selectors without weakening other schema fields", { skip: !sourceDist }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-send-port-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const chunks = fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(sourceDist, name), "utf8").includes("const SessionsSendToolSchema = Type.Object({"));
    assert.equal(chunks.length, 1);
    const file = path.join(dist, chunks[0]);
    fs.copyFileSync(path.join(sourceDist, chunks[0]), file);
    fs.chmodSync(file, 0o644);
    for (let i = 0; i < 2; i++) {
      const patch = spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
      assert.equal(patch.status, 0, patch.stderr);
    }
    const full = fs.readFileSync(file, "utf8");
    const schema = full.slice(full.indexOf("const SessionsSendToolSchema = Type.Object({"), full.indexOf("\n\tmessage: Type.String()", full.indexOf("const SessionsSendToolSchema = Type.Object({")));
    for (const field of ["label", "agentId"]) {
      assert.match(schema, new RegExp(`${field}: Type\\.Optional\\(Type\\.String\\(\\{\\s*minLength: 0,`));
    }
    assert.match(full, /message: Type.String\(\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
