import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = path.join(import.meta.dirname, "patch-tool-result-aggregate-budget-npm-dist.mjs");
const contextScript = path.join(import.meta.dirname, "patch-context-engine-owned-tool-results-npm-dist.mjs");
const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;

function result(id, text) {
  return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 };
}
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 });
const lengths = (messages) => messages.filter((message) => message.role === "toolResult").map((message) => message.content[0].text.length);

test("9.5 aggregate cap, headroom, frozen prefix, and exact recovery", { skip: !sourceDist }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-aggregate-port-"));
  try {
    const dist = path.join(dir, "dist");
    fs.mkdirSync(dist);
    fs.symlinkSync(path.join(sourceDist, "..", "..", "node_modules"), path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const chunks = fs.readdirSync(sourceDist).filter((name) => /^tool-result-truncation-[\w-]+\.mjs$/.test(name))
      .filter((name) => fs.readFileSync(path.join(sourceDist, name), "utf8").includes("function buildAggregateToolResultReplacements("));
    assert.equal(chunks.length, 1);
    const file = path.join(dist, chunks[0]);
    for (const name of fs.readdirSync(sourceDist).filter((name) => name.endsWith(".mjs") && name !== chunks[0])) {
      fs.symlinkSync(path.join(sourceDist, name), path.join(dist, name));
    }
    fs.copyFileSync(path.join(sourceDist, chunks[0]), file);
    fs.chmodSync(file, 0o644);
    // The context-engine adapter is applied after the aggregate adapter in the package.
    const contextChunk = fs.readdirSync(sourceDist).find((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(sourceDist, name), "utf8").includes("function installContextEngineLoopHook(params)"));
    const recoveryChunk = fs.readdirSync(sourceDist).find((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(sourceDist, name), "utf8").includes("async function recoverEmbeddedRunOverflow(input)"));
    for (const name of [contextChunk, recoveryChunk]) {
      fs.rmSync(path.join(dist, name));
      fs.copyFileSync(path.join(sourceDist, name), path.join(dist, name));
      fs.chmodSync(path.join(dist, name), 0o644);
    }
    for (let i = 0; i < 2; i++) {
      for (const patcher of [script, contextScript]) {
        const patch = spawnSync(process.execPath, [patcher], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: dir }, encoding: "utf8" });
        assert.equal(patch.status, 0, patch.stderr);
      }
    }
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO/);
    const chunk = await import(pathToFileURL(file).href);
    const mod = { resolveLiveToolResultAggregateMaxChars: chunk.a, truncateOversizedToolResultsInMessages: chunk.l, estimateToolResultReductionPotential: chunk.t };
    assert.equal(mod.resolveLiveToolResultAggregateMaxChars({ contextWindowTokens: 372_000, perResultMaxChars: 64_000 }), 372_000);
    const messages = [result("a", "a".repeat(5_000)), result("b", "b".repeat(5_000)), result("c", "c".repeat(5_000)), assistant("next")];
    const live = mod.truncateOversizedToolResultsInMessages(messages, 128_000, 12_000, 12_000);
    assert.equal(live.aggregatePressureEngaged, true);
    assert.ok(lengths(live.messages).reduce((sum, length) => sum + length, 0) < 12_000);
    const estimate = mod.estimateToolResultReductionPotential({ messages, contextWindowTokens: 128_000, maxCharsOverride: 12_000, aggregateMaxCharsOverride: 12_000 });
    assert.equal(estimate.aggregateReducibleChars, 15_000 - lengths(live.messages).reduce((sum, length) => sum + length, 0));
    const projected = (await import(pathToFileURL(path.join(sourceDist, fs.readdirSync(sourceDist).find((name) => /^session-prompt-state-[\w-]+\.mjs$/.test(name)))).href)).r();
    const first = mod.truncateOversizedToolResultsInMessages(messages, 128_000, 12_000, 12_000, projected);
    const second = mod.truncateOversizedToolResultsInMessages([...messages, result("d", "d".repeat(2_000)), assistant("again")], 128_000, 12_000, 12_000, projected);
    assert.deepEqual(lengths(second.messages).slice(0, 3), lengths(first.messages));
    const fresh = [assistant("previous"), ...Array.from({ length: 5 }, (_, index) => result(`fresh-${index}`, String(index).repeat(8_000)))];
    const protectedProjection = mod.truncateOversizedToolResultsInMessages(fresh, 128_000, 8_000, 32_000, projected);
    const providerState = (await import(pathToFileURL(path.join(sourceDist, fs.readdirSync(sourceDist).find((name) => /^session-prompt-state-[\w-]+\.mjs$/.test(name)))).href)).r();
    const providerProjection = mod.truncateOversizedToolResultsInMessages(fresh, 128_000, 8_000, 32_000, providerState, { protectTrailingToolResults: false });
    assert.equal(protectedProjection.aggregateTruncatedCount, 0);
    assert.ok(providerProjection.aggregateTruncatedCount > 0, "fresh batch must be bounded at the final provider boundary");
    assert.ok(lengths(providerProjection.messages).reduce((sum, length) => sum + length, 0) <= 32_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
