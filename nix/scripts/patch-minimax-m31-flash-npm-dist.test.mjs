import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const gateway = process.env.OPENCLAW_GATEWAY_PACKAGE;
const script = process.env.OPENCLAW_PATCH_SCRIPT;

test("MiniMax M3.1 Flash advertises five levels and sends selected output_config.effort", { skip: !gateway || !script }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-m31-flash-"));
  try {
    const upstream = path.join(gateway, "lib/openclaw/dist");
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const owners = ["function resolveMinimaxThinkingProfile(", "function createMinimaxThinkingDisabledWrapper("].map((marker) => {
      const matches = fs.readdirSync(upstream).filter((name) => name.endsWith(".mjs") &&
        fs.readFileSync(path.join(upstream, name), "utf8").includes(marker));
      assert.equal(matches.length, 1, marker);
      const file = path.join(dist, matches[0]);
      fs.copyFileSync(path.join(upstream, matches[0]), file);
      fs.chmodSync(file, 0o644);
      return file;
    });
    // The Nix check consumes the already-patched package. Restore the pinned
    // upstream hunks first, so the first invocation tests the actual rewrite.
    const [thinkingFile, proxyFile] = owners;
    const profileInsertion = '\tif (/^MiniMax-M3\\.1-Flash-Preview$/i.test(modelId)) return { levels: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })), defaultLevel: "max" };\n';
    let fixture = fs.readFileSync(thinkingFile, "utf8");
    assert.equal(fixture.split(profileInsertion).length, 2);
    fs.writeFileSync(thinkingFile, fixture.replace(profileInsertion, ""));
    fixture = fs.readFileSync(proxyFile, "utf8");
    const insertionStart = '\t\tconst isM31Flash = /^MiniMax-M3\\.1-Flash-Preview$/i.test(model.id);\n';
    const insertionEnd = '\t\t\t\treturn;\n\t\t\t}\n';
    const start = fixture.indexOf(insertionStart);
    const end = fixture.indexOf(insertionEnd, start);
    assert.ok(start > 0 && end > start && fixture.indexOf(insertionStart, start + 1) === -1);
    // Retain the original streamWithPayloadPatch call between the new guards.
    const originalCall = '\t\treturn streamWithPayloadPatch(underlying, model, context, options, (payload) => {\n';
    assert.equal(fixture.slice(start, end + insertionEnd.length).split(originalCall).length, 2);
    fs.writeFileSync(proxyFile, fixture.slice(0, start) + originalCall + fixture.slice(end + insertionEnd.length));
    const invoke = () => spawnSync(process.execPath, [script], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
    for (let i = 0; i < 2; i++) {
      const result = invoke();
      assert.equal(result.status, 0, result.stderr);
    }
    const [thinking, proxy] = owners.map((file) => fs.readFileSync(file, "utf8"));
    const profileStart = thinking.indexOf("function resolveMinimaxThinkingProfile(");
    const profileEnd = thinking.indexOf("\n//#endregion", profileStart);
    assert.ok(profileStart >= 0 && profileEnd > profileStart);
    const profileScope = { ADAPTIVE_THINKING_LEVELS: ["off", "adaptive"], BUDGET_THINKING_LEVELS: ["off", "minimal", "low", "medium", "high"] };
    vm.createContext(profileScope);
    vm.runInContext(`${thinking.slice(profileStart, profileEnd)}\nthis.profile = resolveMinimaxThinkingProfile;`, profileScope);
    assert.deepEqual(Array.from(profileScope.profile("MiniMax-M3.1-Flash-Preview").levels, (x) => x.id), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(profileScope.profile("MiniMax-M3.1-Flash-Preview").defaultLevel, "max");
    assert.deepEqual(Array.from(profileScope.profile("MiniMax-M3").levels, (x) => x.id), ["off", "adaptive"]);
    const wrapperStart = proxy.indexOf("function createMinimaxThinkingDisabledWrapper(");
    const wrapperEnd = proxy.indexOf("\n//#endregion", wrapperStart);
    assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
    const scope = {
      streamSimple: () => {},
      isMinimaxAnthropicMessagesModel: (model) => model.api === "anthropic-messages" && ["minimax", "minimax-portal"].includes(model.provider),
      isMinimaxM3Model: (model) => /^MiniMax-M3(\b|[-.])/i.test(model.id),
      asOptionalRecord: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
      resolvePositiveMaxTokens: (value) => typeof value === "number" && value > 0 ? Math.floor(value) : undefined,
      streamWithPayloadPatch: (stream, model, context, options, patch) => stream(model, context, {
        ...options,
        onPayload: (payload) => { patch(payload); options?.onPayload?.(payload, model); },
      }),
    };
    vm.createContext(scope);
    vm.runInContext(`${proxy.slice(wrapperStart, wrapperEnd)}\nthis.wrap = createMinimaxThinkingDisabledWrapper;`, scope);
    const capture = (id, level, provider = "minimax") => {
      let captured;
      const stream = scope.wrap((model, _context, options) => {
        const payload = { thinking: { type: "enabled", budget_tokens: 8192 }, output_config: { format: "keep" }, max_tokens: 8692 };
        options?.onPayload?.(payload, model);
        captured = JSON.parse(JSON.stringify(payload));
        return {};
      }, level);
      stream({ provider, api: "anthropic-messages", id }, { messages: [] }, { maxTokens: 500 });
      return captured;
    };
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      assert.deepEqual(capture("MiniMax-M3.1-Flash-Preview", level), {
        thinking: { type: "adaptive" }, output_config: { format: "keep", effort: level }, max_tokens: 500,
      });
    }
    assert.equal(capture("MiniMax-M3.1-Flash-Preview", undefined).output_config.effort, "max");
    assert.equal(capture("MiniMax-M3.1-Flash-Preview", "adaptive").output_config.effort, "max");
    assert.throws(() => capture("MiniMax-M3.1-Flash-Preview", "off"), /does not support thinking off/);
    assert.throws(() => capture("MiniMax-M3.1-Flash-Preview", "minimal"), /does not support thinking level minimal/);
    assert.equal(capture("MiniMax-M3", "adaptive").output_config.effort, undefined);
    assert.equal(capture("MiniMax-M3", "adaptive").thinking.type, "adaptive");
    assert.equal(capture("MiniMax-M2.7", "high").output_config.effort, undefined);
    assert.equal(capture("MiniMax-M3.1-Flash-Preview", "high", "anthropic").output_config.effort, undefined);
    const corrupted = proxy.replace('const isM31Flash = /^MiniMax-M3\\.1-Flash-Preview$/i.test(model.id);', 'const isM31Flash = false;');
    assert.notEqual(corrupted, proxy);
    fs.writeFileSync(owners[1], corrupted);
    assert.notEqual(invoke().status, 0, "unexpected upstream change must fail closed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
