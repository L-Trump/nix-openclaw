import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const sourceDist = process.env.OPENCLAW_GATEWAY_DIST;
const scriptDir = import.meta.dirname;
function chunk(dist, marker) {
  const matches = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(dist, name), "utf8").includes(marker));
  assert.equal(matches.length, 1, marker);
  return matches[0];
}
function extract(source, start, end) {
  const left = source.indexOf(start);
  const right = source.indexOf(end, left + start.length);
  assert.ok(left >= 0 && right > left, `${start}: missing boundaries`);
  return source.slice(left, right);
}

test("authoritative assembly bypasses heuristic guard; uncertain or failed assembly retains it", { skip: !sourceDist }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-engine-port-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const chunks = [chunk(sourceDist, "function installContextEngineLoopHook(params)"), chunk(sourceDist, "async function recoverEmbeddedRunOverflow(input)"), chunk(sourceDist, "function buildAggregateToolResultReplacements(")];
    for (const name of chunks) {
      const file = path.join(dist, name);
      fs.copyFileSync(path.join(sourceDist, name), file);
      fs.chmodSync(file, 0o644);
    }
    for (const name of ["patch-tool-result-aggregate-budget-npm-dist.mjs", "patch-context-engine-owned-tool-results-npm-dist.mjs"]) {
      for (let i = 0; i < 2; i++) {
        const result = spawnSync(process.execPath, [path.join(scriptDir, name)], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const builtin = fs.readFileSync(path.join(dist, chunks[0]), "utf8");
    const recovery = fs.readFileSync(path.join(dist, chunks[1]), "utf8");
    const truncation = fs.readFileSync(path.join(dist, chunks[2]), "utf8");
    assert.match(recovery, /preflightRecovery\?\.route === "compact_then_truncate" && input\.contextEngine\.info\.ownsCompaction !== true/);
    assert.match(recovery, /!parkedWorkBlocksContinuation && input\.contextEngine\.info\.ownsCompaction !== true && !input\.state\.toolResultTruncationAttempted/);
    assert.match(builtin, /contextEngineOwnsCompaction: activeContextEngine\?\.info\.ownsCompaction === true/);
    assert.match(builtin, /protectTrailingToolResults: false/);
    assert.match(truncation, /projectionOptions\?\.protectTrailingToolResults \?\? Boolean\(projectionState\)/);

    let guarded = 0;
    let checked = 0;
    const precheckFences = [];
    const sandbox = {
      estimateTokens: () => 1,
      projectTranscriptPromptMessages: (messages) => messages,
      stripTranscriptPromptMarkers: (messages) => messages,
      enforceToolResultLimit: ({ messages }) => { guarded++; return messages.map((message) => ({ ...message, guarded: true })); },
      resolveToolResultContextMaxChars: () => 1024,
      shouldPreemptivelyCompactBeforePrompt: () => { checked++; return { route: "fits" }; },
      hasNewToolResultAfterFence: ({ messages: view, prePromptMessageCount }) => {
        precheckFences.push(prePromptMessageCount);
        return view.slice(prePromptMessageCount).some((message) => message.role === "toolResult");
      },
      toMidTurnPrecheckRequest: () => null,
      log$6: { debug() {} },
      MidTurnPrecheckSignal: class extends Error {},
    };
    vm.createContext(sandbox);
    vm.runInContext(
      extract(builtin, "function installContextEngineLoopHook(params)", "function installToolResultContextGuard(params)") +
      extract(builtin, "function installToolResultContextGuard(params)", "//#endregion"),
      sandbox,
    );
    const messages = [{ role: "user", content: "prompt" }, { role: "toolResult", content: "large" }];
    const engine = { afterTurn: async () => {}, assemble: async () => ({ messages, promptAuthority: "assembled" }) };
    const agent = {};
    let state;
    sandbox.installContextEngineLoopHook({ agent, contextEngine: engine, sessionId: "test", sessionFile: "test", modelId: "model", getPrePromptMessageCount: () => 1, onAssemblyStateChange: (value) => { state = value; } });
    sandbox.installToolResultContextGuard({ agent, contextWindowTokens: 1000, isContextEngineAssemblyAuthoritative: () => state?.succeeded === true && state.promptAuthority !== "preassembly_may_overflow", midTurnPrecheck: { enabled: true, getPrePromptMessageCount: () => 1, contextTokenBudget: 1000, reserveTokens: () => 0 } });
    const signal = new AbortController().signal;
    assert.equal(await agent.transformContext(messages, signal), messages);
    assert.deepEqual({ ...state }, { succeeded: true, promptAuthority: "assembled" });
    assert.equal(await agent.transformContext(messages, signal), messages, "cached assembly must retain authority");
    assert.equal(guarded, 0);
    assert.equal(checked, 0);
    const changed = [...messages, { role: "toolResult", content: "second" }];
    engine.assemble = async () => ({ messages: changed, promptAuthority: "preassembly_may_overflow" });
    const uncertain = await agent.transformContext(changed, signal);
    assert.ok(uncertain.every((message) => message.guarded));
    assert.ok(guarded > 0 && checked > 0);
    assert.equal(precheckFences[0], 2, "failed authority must only inspect results beyond the last accepted assembly");
    const guardedBeforeFailure = guarded;
    engine.assemble = async () => { throw new Error("assembly failed"); };
    await agent.transformContext([...changed, { role: "toolResult", content: "third" }], signal);
    assert.ok(guarded > guardedBeforeFailure, "failed assembly must not bypass guard");
    assert.equal(state.succeeded, false);

    let persistedTruncations = 0;
    const routing = {
      log$6: { warn() {} },
      buildPreflightRecoveryBudgetSnapshot: (request) => ({ overflowTokens: request.overflowTokens }),
      PREEMPTIVE_OVERFLOW_ERROR_TEXT: "Context overflow: precheck",
      truncateOversizedToolResultsInSessionManager: () => { persistedTruncations++; return { truncated: true, truncatedCount: 1 }; },
      resolveLiveToolResultMaxChars: () => 1000,
      sanitizeCompactionReplayMessages: (messages) => messages,
    };
    vm.createContext(routing);
    vm.runInContext(extract(builtin, "function handleEmbeddedAttemptMidTurnPrecheck(input)", "async function prepareEmbeddedAttemptPromptPreflight(input)"), routing);
    const attempt = { provider: "test", modelId: "test", sessionId: "test", contextTokenBudget: 1000, sessionFile: "test" };
    const request = { route: "truncate_tool_results_only", overflowTokens: 100, estimatedPromptTokens: 1100, promptBudgetBeforeReserve: 1000, toolResultReducibleChars: 1000, effectiveReserveTokens: 0 };
    const input = { attempt, request, sessionAgentId: "test", sessionManager: { buildSessionContext: () => ({ messages }) }, toolResultPromptProjectionState: {}, prePromptMessageCount: 1, replaceSessionMessages: () => {} };
    const owner = routing.handleEmbeddedAttemptMidTurnPrecheck({ ...input, contextEngineOwnsCompaction: true });
    assert.equal(owner.preflightRecovery.route, "compact_only");
    assert.match(owner.promptError.message, /Context overflow/);
    assert.equal(persistedTruncations, 0);
    const legacy = routing.handleEmbeddedAttemptMidTurnPrecheck(input);
    assert.equal(legacy.preflightRecovery.handled, true);
    assert.equal(persistedTruncations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
