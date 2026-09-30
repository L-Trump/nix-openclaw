import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";

const script = process.env.OPENCLAW_PATCH_SCRIPT ?? path.join(import.meta.dirname, "patch-opencode-go-deepseek-flash-npm-dist.mjs");
const gateway = process.env.OPENCLAW_GATEWAY_PACKAGE;

test("pinned OpenCode Go bundle patches only V4.1 Flash and preserves existing V4 effort mappings", { skip: !gateway }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-opencode-flash-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const upstream = path.join(gateway, "lib/openclaw/dist");
    const owners = fs.readdirSync(upstream).filter((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(upstream, name), "utf8").includes("function createOpencodeGoDeepSeekWrapper("));
    assert.equal(owners.length, 1);
    const file = path.join(dist, owners[0]);
    fs.copyFileSync(path.join(upstream, owners[0]), file);
    fs.chmodSync(file, 0o644);
    const marker = 'shouldPatchModel: (model) => model.provider === "opencode-go" && model.id === "deepseek-v4-pro"';
    const patched = 'shouldPatchModel: (model) => model.provider === "opencode-go" && (model.id === "deepseek-v4-pro" || model.id === "deepseek-flash")';
    const fixture = fs.readFileSync(file, "utf8");
    // The package check uses the already-patched gateway; restore this exact pinned hunk
    // so the first invocation also tests the npm install-time transformation.
    assert.equal(fixture.split(patched).length, 2);
    fs.writeFileSync(file, fixture.replace(patched, marker));
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const source = fs.readFileSync(file, "utf8");
    const begin = source.indexOf("function createOpencodeGoDeepSeekWrapper(");
    const end = source.indexOf("function createOpencodeGoWireWrapper(", begin);
    assert.ok(begin >= 0 && end > begin);
    const { createDeepSeekV4OpenAICompatibleThinkingWrapper } = await import(pathToFileURL(
      path.join(gateway, "lib/openclaw/dist/plugin-sdk/provider-stream-shared.js"),
    ).href);
    const sandbox = { createDeepSeekV4OpenAICompatibleThinkingWrapper };
    vm.createContext(sandbox);
    vm.runInContext(`${source.slice(begin, end)}\nthis.wrap = createOpencodeGoDeepSeekWrapper;`, sandbox);
    const capture = (provider, id, level) => {
      let captured;
      const stream = sandbox.wrap((model, _context, options) => {
        const payload = { model: model.id, messages: [] };
        options?.onPayload?.(payload, model);
        captured = payload;
        return {};
      }, level);
      stream({ provider, id, api: "openai-completions" }, { messages: [] }, {});
      return captured;
    };
    assert.deepEqual(["off", "high", "max"].map((level) => capture("opencode-go", "deepseek-flash", level)), [
      { model: "deepseek-flash", messages: [], thinking: { type: "disabled" } },
      { model: "deepseek-flash", messages: [], thinking: { type: "enabled" }, reasoning_effort: "high" },
      { model: "deepseek-flash", messages: [], thinking: { type: "enabled" }, reasoning_effort: "max" },
    ]);
    assert.equal(capture("opencode-go", "deepseek-v4-flash", "low").reasoning_effort, "low");
    assert.deepEqual(capture("deepseek", "deepseek-flash", "max"), { model: "deepseek-flash", messages: [] });
    const unexpected = fs.readFileSync(file, "utf8").replace('model.id === "deepseek-v4-pro" || model.id === "deepseek-flash"', 'model.id === "unknown"');
    fs.writeFileSync(file, unexpected);
    const rejected = spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), unexpected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
