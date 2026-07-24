#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function lines(...values) {
  return values.join("\n");
}

function replaceExactlyOnce(source, oldText, newText, label) {
  if (source.includes(newText)) {
    return source;
  }
  const matches = source.split(oldText).length - 1;
  if (matches !== 1) {
    fail(`${label}: expected one match, found ${matches}`);
  }
  return source.replace(oldText, newText);
}

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  fail("OPENCLAW_PACKAGE_ROOT is required");
}

const distDir = path.join(root, "dist");
if (!fs.existsSync(distDir)) {
  fail(`OpenClaw dist directory missing: ${distDir}`);
}

const distFiles = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(distDir, name));

const candidates = distFiles.filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return (
    source.includes("function installContextEngineLoopHook") &&
    source.includes("function installToolResultContextGuard") &&
    source.includes("const removeContextEngineLoopHook = installContextEngineLoopHook")
  );
});
if (candidates.length !== 1) {
  fail(`expected exactly one context guard chunk, found ${candidates.length}`);
}
const chunk = candidates[0];
let source = fs.readFileSync(chunk, "utf8");

const oldSourceHistoryReset = lines(
  "\t\tif (lastSeenLength != null && lastSourceMessages != null && (transcriptMessages.length < lastSeenLength || transcriptMessages.length === lastSeenLength && transcriptMessages.slice(0, checkedPrefixLength).some((message, index) => message !== lastSourceMessages?.[index]))) {",
  "\t\t\tlastSeenLength = null;",
  "\t\t\tlastAssembledView = null;",
  "\t\t}",
);
const patchedSourceHistoryReset = lines(
  "\t\tif (lastSeenLength != null && lastSourceMessages != null && (transcriptMessages.length < lastSeenLength || transcriptMessages.length === lastSeenLength && transcriptMessages.slice(0, checkedPrefixLength).some((message, index) => message !== lastSourceMessages?.[index]))) {",
  "\t\t\tlastSeenLength = null;",
  "\t\t\tlastAssembledView = null;",
  '\t\t\tparams.onAssemblyStateChange?.({ succeeded: false, promptAuthority: "assembled" });',
  "\t\t}",
);
source = replaceExactlyOnce(
  source,
  oldSourceHistoryReset,
  patchedSourceHistoryReset,
  "loop assembly source-history reset",
);

const oldBeforeLoopAssembly = lines(
  "\t\tif (!(transcriptMessages.length > prePromptMessageCount)) {",
  "\t\t\tlastSeenLength = prePromptMessageCount;",
  "\t\t\tlastSourceMessages = transcriptMessages;",
  "\t\t\treturn lastAssembledView ?? providerMessages;",
  "\t\t}",
  "\t\ttry {",
);
const patchedBeforeLoopAssembly = lines(
  "\t\tif (!(transcriptMessages.length > prePromptMessageCount)) {",
  "\t\t\tlastSeenLength = prePromptMessageCount;",
  "\t\t\tlastSourceMessages = transcriptMessages;",
  "\t\t\treturn lastAssembledView ?? providerMessages;",
  "\t\t}",
  '\t\tparams.onAssemblyStateChange?.({ succeeded: false, promptAuthority: "assembled" });',
  "\t\ttry {",
);
source = replaceExactlyOnce(
  source,
  oldBeforeLoopAssembly,
  patchedBeforeLoopAssembly,
  "loop assembly pending state",
);

const oldAssemblySuccess = lines(
  "\t\t\tif (assembled && Array.isArray(assembled.messages)) {",
  "\t\t\t\tconst repairedMessages = params.repairAssembledMessages?.(assembled.messages) ?? assembled.messages;",
);
const patchedAssemblySuccess = lines(
  "\t\t\tif (assembled && Array.isArray(assembled.messages)) {",
  '\t\t\t\tparams.onAssemblyStateChange?.({ succeeded: true, promptAuthority: assembled.promptAuthority ?? "assembled" });',
  "\t\t\t\tconst repairedMessages = params.repairAssembledMessages?.(assembled.messages) ?? assembled.messages;",
);
source = replaceExactlyOnce(
  source,
  oldAssemblySuccess,
  patchedAssemblySuccess,
  "loop assembly authoritative state",
);

const oldAssemblyFailure = lines(
  "\t\t} catch {",
  "\t\t\tlastSeenLength = prePromptMessageCount;",
  "\t\t\tlastAssembledView = null;",
  "\t\t\tlastSourceMessages = transcriptMessages;",
  "\t\t}",
  "\t\treturn providerMessages;",
);
const patchedAssemblyFailure = lines(
  "\t\t} catch {",
  "\t\t\tlastSeenLength = prePromptMessageCount;",
  "\t\t\tlastAssembledView = null;",
  "\t\t\tlastSourceMessages = transcriptMessages;",
  '\t\t\tparams.onAssemblyStateChange?.({ succeeded: false, promptAuthority: "assembled" });',
  "\t\t}",
  "\t\treturn providerMessages;",
);
source = replaceExactlyOnce(
  source,
  oldAssemblyFailure,
  patchedAssemblyFailure,
  "loop assembly failure state",
);

const oldGuardAfterSingleLimit = lines(
  "\t\tif (contextMessages !== sourceMessages) enforceToolResultLimitInPlace({",
  "\t\t\tmessages: contextMessages,",
  "\t\t\tmaxSingleToolResultChars",
  "\t\t});",
  "\t\tif (params.midTurnPrecheck?.enabled) {",
);
const patchedGuardAfterSingleLimit = lines(
  "\t\tif (contextMessages !== sourceMessages) enforceToolResultLimitInPlace({",
  "\t\t\tmessages: contextMessages,",
  "\t\t\tmaxSingleToolResultChars",
  "\t\t});",
  "\t\tconst contextEngineAssemblyAuthoritative = params.isContextEngineAssemblyAuthoritative?.() === true;",
  "\t\tif (params.midTurnPrecheck?.enabled && !contextEngineAssemblyAuthoritative) {",
);
source = replaceExactlyOnce(
  source,
  oldGuardAfterSingleLimit,
  patchedGuardAfterSingleLimit,
  "authority-aware mid-turn precheck",
);

const oldGuardTail = lines(
  "\t\t\tlastSeenLength = contextMessages.length;",
  "\t\t}",
  "\t\tif (exceedsPreemptiveOverflowThreshold({",
  "\t\t\tmessages: contextMessages,",
  "\t\t\tmaxContextChars",
  "\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);",
  "\t\treturn contextMessages;",
);
const patchedGuardTail = lines(
  "\t\t\tlastSeenLength = contextMessages.length;",
  "\t\t} else if (params.midTurnPrecheck?.enabled) lastSeenLength = contextMessages.length;",
  "\t\tif (!contextEngineAssemblyAuthoritative) {",
  "\t\t\tif (exceedsPreemptiveOverflowThreshold({",
  "\t\t\t\tmessages: contextMessages,",
  "\t\t\t\tmaxContextChars",
  "\t\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);",
  "\t\t} else log$2.debug(\"[tool-result-guard] skipped heuristic overflow checks: context engine returned an authoritative assembly\");",
  "\t\treturn contextMessages;",
);
source = replaceExactlyOnce(
  source,
  oldGuardTail,
  patchedGuardTail,
  "authority-aware aggregate overflow guard",
);

const oldOwnerBranchStart = lines(
  '\t\t\tif (activeContextEngine?.info.ownsCompaction === true) {',
  "\t\t\t\tconst selectedContextEngineId = activeContextEngine.info.id;",
);
const patchedOwnerBranchStart = lines(
  '\t\t\tif (activeContextEngine?.info.ownsCompaction === true) {',
  "\t\t\t\tlet contextEngineLoopAssemblyState = null;",
  "\t\t\t\tconst selectedContextEngineId = activeContextEngine.info.id;",
);
source = replaceExactlyOnce(
  source,
  oldOwnerBranchStart,
  patchedOwnerBranchStart,
  "loop assembly state declaration",
);

const oldLoopHookTail = lines(
  "\t\t\t\t\truntimeSettings: contextEngineLoopRuntimeSettings,",
  "\t\t\t\t\tisHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind)",
  "\t\t\t\t});",
  "\t\t\t\tconst removeGuard = installToolResultContextGuard({",
  "\t\t\t\t\tagent: activeSession.agent,",
  "\t\t\t\t\tcontextWindowTokens: contextTokenBudgetForGuard,",
  "\t\t\t\t\t...midTurnPrecheckOptions",
  "\t\t\t\t});",
);
const patchedLoopHookTail = lines(
  "\t\t\t\t\truntimeSettings: contextEngineLoopRuntimeSettings,",
  "\t\t\t\t\tonAssemblyStateChange: (state) => {",
  "\t\t\t\t\t\tcontextEngineLoopAssemblyState = state;",
  "\t\t\t\t\t},",
  "\t\t\t\t\tisHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind)",
  "\t\t\t\t});",
  "\t\t\t\tconst removeGuard = installToolResultContextGuard({",
  "\t\t\t\t\tagent: activeSession.agent,",
  "\t\t\t\t\tcontextWindowTokens: contextTokenBudgetForGuard,",
  "\t\t\t\t\tisContextEngineAssemblyAuthoritative: () => {",
  "\t\t\t\t\t\tconst loopState = contextEngineLoopAssemblyState;",
  '\t\t\t\t\t\tif (loopState) return loopState.succeeded && loopState.promptAuthority !== "preassembly_may_overflow";',
  '\t\t\t\t\t\treturn contextEngineAssemblySucceeded && contextEnginePromptAuthority !== "preassembly_may_overflow";',
  "\t\t\t\t\t},",
  "\t\t\t\t\t...midTurnPrecheckOptions",
  "\t\t\t\t});",
);
source = replaceExactlyOnce(
  source,
  oldLoopHookTail,
  patchedLoopHookTail,
  "loop assembly authority wiring",
);

for (const marker of [
  "onAssemblyStateChange?.({ succeeded: true",
  "isContextEngineAssemblyAuthoritative",
  "contextEngineAssemblyAuthoritative",
  "contextEngineLoopAssemblyState",
  "context engine returned an authoritative assembly",
  'promptAuthority !== "preassembly_may_overflow"',
]) {
  if (!source.includes(marker)) {
    fail(`authoritative context guard patch marker missing: ${marker}`);
  }
}

fs.writeFileSync(chunk, source);
