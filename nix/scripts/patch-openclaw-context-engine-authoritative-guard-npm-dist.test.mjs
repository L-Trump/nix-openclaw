import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const script = path.join(
  import.meta.dirname,
  "patch-openclaw-context-engine-authoritative-guard-npm-dist.mjs",
);

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-authoritative-guard-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  const chunk = path.join(dist, "selection-fixture.js");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    chunk,
    `const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE = "overflow";
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const log$2 = { debug() {} };
function projectTranscriptPromptMessages(messages) { return messages; }
function stripTranscriptPromptMarkers(messages) { return messages; }
function toolResultsNeedTruncation() { return false; }
function enforceToolResultLimitInPlace() {}
function shouldPreemptivelyCompactBeforePrompt() { return { route: "compact" }; }
function exceedsPreemptiveOverflowThreshold() { return true; }
function installContextEngineLoopHook(params) {
	const mutableAgent = params.agent;
	let lastSeenLength = null;
	let lastAssembledView = null;
	let lastSourceMessages = null;
	mutableAgent.transformContext = (async (messages, signal) => {
		const sourceMessages = messages;
		const transcriptMessages = sourceMessages;
		const providerMessages = sourceMessages;
		const checkedPrefixLength = lastSeenLength == null ? 0 : Math.min(lastSeenLength, transcriptMessages.length);
		if (lastSeenLength != null && lastSourceMessages != null && (transcriptMessages.length < lastSeenLength || transcriptMessages.length === lastSeenLength && transcriptMessages.slice(0, checkedPrefixLength).some((message, index) => message !== lastSourceMessages?.[index]))) {
			lastSeenLength = null;
			lastAssembledView = null;
		}
		const prePromptMessageCount = 0;
		if (!(transcriptMessages.length > prePromptMessageCount)) {
			lastSeenLength = prePromptMessageCount;
			lastSourceMessages = transcriptMessages;
			return lastAssembledView ?? providerMessages;
		}
		try {
			const assembled = await params.contextEngine.assemble({ messages: providerMessages });
			if (assembled && Array.isArray(assembled.messages)) {
				const repairedMessages = params.repairAssembledMessages?.(assembled.messages) ?? assembled.messages;
				if (repairedMessages !== providerMessages || assembled.messages !== providerMessages) return repairedMessages;
			}
			lastAssembledView = null;
		} catch {
			lastSeenLength = prePromptMessageCount;
			lastAssembledView = null;
			lastSourceMessages = transcriptMessages;
		}
		return providerMessages;
	});
}
function installToolResultContextGuard(params) {
	const maxContextChars = 1;
	const maxSingleToolResultChars = 1;
	const mutableAgent = params.agent;
	const originalTransformContext = mutableAgent.transformContext;
	let lastSeenLength = null;
	mutableAgent.transformContext = (async (messages, signal) => {
		const sourceMessages = originalTransformContext ? await originalTransformContext(messages, signal) : messages;
		const contextMessages = sourceMessages;
		if (contextMessages !== sourceMessages) enforceToolResultLimitInPlace({
			messages: contextMessages,
			maxSingleToolResultChars
		});
		if (params.midTurnPrecheck?.enabled) {
			const precheck = shouldPreemptivelyCompactBeforePrompt({ messages: contextMessages });
			if (precheck.route !== "fits") throw new Error("midturn");
			lastSeenLength = contextMessages.length;
		}
		if (exceedsPreemptiveOverflowThreshold({
			messages: contextMessages,
			maxContextChars
		})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
		return contextMessages;
	});
}
async function runEmbeddedAttempt(params) {
	let contextEngineAssemblySucceeded = false;
	let contextEnginePromptAuthority = "assembled";
			if (activeContextEngine?.info.ownsCompaction === true) {
				const selectedContextEngineId = activeContextEngine.info.id;
				const removeContextEngineLoopHook = installContextEngineLoopHook({
					agent: activeSession.agent,
					contextEngine: activeContextEngine,
					runtimeSettings: contextEngineLoopRuntimeSettings,
					isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind)
				});
				const removeGuard = installToolResultContextGuard({
					agent: activeSession.agent,
					contextWindowTokens: contextTokenBudgetForGuard,
					...midTurnPrecheckOptions
				});
			}
}
export { installContextEngineLoopHook, installToolResultContextGuard };
`,
  );
  return { root, chunk };
}

function runPatch(root) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("wires per-call context-engine assembly authority into the tool guard idempotently", () => {
  const { root, chunk } = makeFixture();
  const first = runPatch(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runPatch(root);
  assert.equal(second.status, 0, second.stderr);

  const source = fs.readFileSync(chunk, "utf8");
  assert.match(source, /onAssemblyStateChange\?\.\(\{ succeeded: true/);
  assert.match(source, /onAssemblyStateChange: \(state\)/);
  assert.match(source, /isContextEngineAssemblyAuthoritative/);
  assert.match(source, /contextEngineAssemblyAuthoritative/);
  assert.match(source, /contextEngineLoopAssemblyState/);
  assert.match(source, /preassembly_may_overflow/);
  assert.match(source, /context engine returned an authoritative assembly/);
});

test("skips heuristics only for authoritative assembly and restores them on failure", async () => {
  const { root, chunk } = makeFixture();
  const patched = runPatch(root);
  assert.equal(patched.status, 0, patched.stderr);

  const { installContextEngineLoopHook, installToolResultContextGuard } = await import(
    `${pathToFileURL(chunk).href}?test=${Date.now()}`
  );
  const messages = [{ role: "user", content: "u" }, { role: "toolResult", content: "r" }];

  async function runCase({ assemble, expected }) {
    const agent = {};
    let assemblyState = null;
    installContextEngineLoopHook({
      agent,
      contextEngine: { assemble, ingest: async () => ({ ingested: true }) },
      tokenBudget: 1_000,
      getPrePromptMessageCount: () => 0,
      onAssemblyStateChange: (state) => {
        assemblyState = state;
      },
    });
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
      isContextEngineAssemblyAuthoritative: () =>
        assemblyState?.succeeded === true &&
        assemblyState.promptAuthority !== "preassembly_may_overflow",
    });

    if (expected === "pass") {
      assert.equal(await agent.transformContext(messages, new AbortController().signal), messages);
      assert.equal(await agent.transformContext(messages, new AbortController().signal), messages);
    } else {
      await assert.rejects(
        agent.transformContext(messages, new AbortController().signal),
        /overflow/,
      );
    }
  }

  await runCase({
    assemble: async ({ messages: assembledMessages }) => ({
      messages: assembledMessages,
      promptAuthority: "assembled",
    }),
    expected: "pass",
  });
  await runCase({
    assemble: async ({ messages: assembledMessages }) => ({
      messages: assembledMessages,
      promptAuthority: "preassembly_may_overflow",
    }),
    expected: "overflow",
  });
  await runCase({
    assemble: async () => {
      throw new Error("assemble failed");
    },
    expected: "overflow",
  });
});
