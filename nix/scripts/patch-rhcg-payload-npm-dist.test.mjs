import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;
const patch = path.join(import.meta.dirname, "patch-rhcg-payload-npm-dist.mjs");

test("RHCG-only Responses/Completions effort and tier at final payload hook", { skip: !sourceDist }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rhcg-payload-"));
  try {
    const dist = path.join(root, "dist");
    const assetDir = path.join(dist, "control-ui", "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    const owner = fs.readdirSync(sourceDist).find((name) => name.endsWith(".mjs") &&
      fs.readFileSync(path.join(sourceDist, name), "utf8").includes("function applyPostPluginStreamWrappers(ctx)"));
    assert.ok(owner);
    const assets = fs.readdirSync(path.join(sourceDist, "control-ui", "assets"));
    const ui = assets.find((name) => fs.readFileSync(path.join(sourceDist, "control-ui", "assets", name), "utf8")
      .includes("new Set([`anthropic`,`minimax`,`minimax-portal`,`openai`,`xai`])"));
    assert.ok(ui);
    for (const name of [owner]) fs.copyFileSync(path.join(sourceDist, name), path.join(dist, name));
    fs.copyFileSync(path.join(sourceDist, "control-ui", "assets", ui), path.join(assetDir, ui));
    fs.copyFileSync(path.join(sourceDist, "control-ui", "sw.js"), path.join(dist, "control-ui", "sw.js"));
    for (const file of [path.join(dist, owner), path.join(assetDir, ui), path.join(dist, "control-ui", "sw.js")]) {
      fs.chmodSync(file, 0o644);
    }
    const fixture = { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [patch], fixture);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.match(fs.readFileSync(path.join(assetDir, ui), "utf8"), /`rhcg`/);
    assert.match(fs.readFileSync(path.join(dist, "control-ui", "sw.js"), "utf8"), /-rhcg-openai-compat/);
    const source = fs.readFileSync(path.join(dist, owner), "utf8");
    const start = source.indexOf("function createRhcgRequestWrapper(");
    const end = source.indexOf("function applyPostPluginStreamWrappers(", start);
    assert.ok(start >= 0 && end > start);
    const runtime = {
      resolveAliasedParamValueFromKeys: (sources, keys) => keys.map((key) => sources[0]?.[key]).find((value) => value !== undefined),
      streamWithPayloadPatch: (underlying, model, context, options, change) => underlying(model, context, {
        ...options, onPayload: (payload) => { change(payload); return options?.onPayload?.(payload, model); },
      }),
    };
    vm.createContext(runtime);
    vm.runInContext(source.slice(start, end), runtime);
    const send = (model, level, params, body) => {
      let request;
      const base = (m, c, options) => { request = body; options.onPayload?.(request, m); return request; };
      runtime.createRhcgRequestWrapper(base, level, params)(model, {}, {});
      return request;
    };
    const rhcg = { provider: "rhcg", api: "openai-responses", reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "xhigh", "max"] } };
    assert.deepEqual(JSON.parse(JSON.stringify(send(rhcg, "max", { fastMode: true }, {}))), { service_tier: "priority", reasoning: { effort: "max" } });
    assert.deepEqual(JSON.parse(JSON.stringify(send({ ...rhcg, api: "openai-completions" }, "xhigh", { fastMode: true, serviceTier: "flex" }, {}))),
      { service_tier: "flex", reasoning_effort: "xhigh" });
    assert.equal(send(rhcg, "off", {}, { reasoning: { effort: "high" } }).reasoning, undefined);
    assert.equal(send({ ...rhcg, compat: { supportsReasoningEffort: false } }, "max", {}, {}).reasoning, undefined);
    assert.equal(send({ ...rhcg, provider: "other" }, "max", { fastMode: true }, {}).service_tier, undefined);
    assert.equal(send(rhcg, "high", { fastMode: "auto" }, {}).service_tier, undefined);
    assert.equal(send(rhcg, "high", { fastMode: true }, { service_tier: "default" }).service_tier, "default");
    assert.equal(send({ ...rhcg, compat: { supportedReasoningEfforts: ["high"] } }, "max", {}, {}).reasoning, undefined);
    assert.equal(send({ ...rhcg, reasoning: false }, "max", {}, {}).reasoning, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
