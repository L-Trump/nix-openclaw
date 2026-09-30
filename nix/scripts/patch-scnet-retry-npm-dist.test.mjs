import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(import.meta.dirname, "patch-scnet-retry-npm-dist.mjs");
const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;

test("SCNet headerless 429 exception is scoped and repeatable on pinned transport", { skip: !sourceDist }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scnet-retry-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const chunks = fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(sourceDist, name), "utf8").includes("function shouldBypassLongSdkRetry(response)"));
    assert.equal(chunks.length, 1);
    const file = path.join(dist, chunks[0]);
    fs.copyFileSync(path.join(sourceDist, chunks[0]), file);
    fs.chmodSync(file, 0o644);
    for (let i = 0; i < 2; i++) {
      const patched = spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
      assert.equal(patched.status, 0, patched.stderr);
    }
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.split("const allowScnetHeaderless429 =").length, 2);
    const gate = source.match(/const allowScnetHeaderless429 = ([^;]+);/);
    assert.ok(gate);
    const allow = new Function("model", "response", `return ${gate[1]}`);
    assert.equal(allow({ provider: "scnet" }, new Response(null, { status: 429 })), true);
    assert.equal(allow({ provider: "other" }, new Response(null, { status: 429 })), false);
    assert.equal(allow({ provider: "scnet" }, new Response(null, { status: 429, headers: { "Retry-After": "60" } })), false);
    assert.equal(allow({ provider: "scnet" }, new Response(null, { status: 429, headers: { "Retry-After-Ms": "bogus" } })), false);
    assert.equal(allow({ provider: "scnet" }, new Response(null, { status: 500 })), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
