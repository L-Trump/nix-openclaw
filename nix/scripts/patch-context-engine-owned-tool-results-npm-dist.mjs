#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
function owner(marker) {
  const files = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))
    .map((name) => path.join(dist, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(marker));
  if (files.length !== 1) {
    throw new Error(`${marker}: expected one chunk, found ${files.length}`);
  }
  return files[0];
}
function replaceOnce(source, before, after, label) {
  const patchedCount = source.split(after).length - 1;
  if (patchedCount === 1) {
    return source;
  }
  const count = source.split(before).length - 1;
  if (count === 1 && patchedCount === 0) {
    return source.replace(before, after);
  }
  throw new Error(`${label}: expected one original or patched match, found ${count}/${patchedCount}`);
}
function section(source, start, end, transform) {
  const left = source.indexOf(start);
  const right = source.indexOf(end, left + start.length);
  if (left < 0 || right < left) {
    throw new Error(`missing section ${start} to ${end}`);
  }
  return source.slice(0, left) + transform(source.slice(left, right)) + source.slice(right);
}
const builtin = owner("function installContextEngineLoopHook(params)");
let source = fs.readFileSync(builtin, "utf8");
source = section(source, "function installContextEngineLoopHook(params)", "function installToolResultContextGuard(params)", (part) => {
  part = replaceOnce(part, "let lastSourceMessages = null;", "let lastSourceMessages = null;\n\tlet lastPromptAuthority = \"assembled\";", "last assembly authority");
  part = replaceOnce(part,
    "\t\tconst prePromptMessageCount = Math.max(0, Math.min(transcriptMessages.length,",
    "\t\tparams.onAssemblyStateChange?.({ succeeded: false, promptAuthority: \"assembled\" });\n\t\tconst prePromptMessageCount = Math.max(0, Math.min(transcriptMessages.length,",
    "reset assembly state");
  part = replaceOnce(part,
    "\t\t\tlastSourceMessages = transcriptMessages;\n\t\t\treturn lastAssembledView ?? providerMessages;",
    "\t\t\tlastSourceMessages = transcriptMessages;\n\t\t\tif (lastAssembledView) params.onAssemblyStateChange?.({ succeeded: true, promptAuthority: lastPromptAuthority });\n\t\t\treturn lastAssembledView ?? providerMessages;",
    "cached assembly state");
  part = replaceOnce(part,
    "\t\t\tlastAssembledView = params.repairAssembledMessages?.(modelMessages) ?? modelMessages;\n\t\t\treturn lastAssembledView;",
    "\t\t\tlastAssembledView = params.repairAssembledMessages?.(modelMessages) ?? modelMessages;\n\t\t\tlastPromptAuthority = assembled.promptAuthority ?? \"assembled\";\n\t\t\tparams.onAssemblyStateChange?.({ succeeded: true, promptAuthority: lastPromptAuthority });\n\t\t\treturn lastAssembledView;",
    "successful assembly state");
  return part;
});
source = section(source, "function installToolResultContextGuard(params)", "//#endregion", (part) => replaceOnce(part,
  "\t\tconst contextMessages = enforceToolResultLimit({\n\t\t\tmessages: Array.isArray(transformed) ? transformed : messages,",
  "\t\tconst sourceMessages = Array.isArray(transformed) ? transformed : messages;\n\t\tif (params.isContextEngineAssemblyAuthoritative?.()) {\n\t\t\tif (params.midTurnPrecheck?.enabled) lastSeenLength = sourceMessages.length;\n\t\t\treturn sourceMessages;\n\t\t}\n\t\tconst contextMessages = enforceToolResultLimit({\n\t\t\tmessages: sourceMessages,",
  "authoritative context guard"));
source = section(source, "function installEmbeddedAttemptContextGuards(input)", "function startEmbeddedAttemptDiagnostics(", (part) => {
  part = replaceOnce(part, "\tlet removeContextEngineLoopHook;", "\tlet removeContextEngineLoopHook;\n\tlet contextEngineLoopAssemblyState = null;", "attempt assembly state");
  part = replaceOnce(part,
    "\t\t\truntimeSettings,\n\t\t\tisHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind)",
    "\t\t\truntimeSettings,\n\t\t\tonAssemblyStateChange: (state) => { contextEngineLoopAssemblyState = state; },\n\t\t\tisHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind)",
    "assembly callback wiring");
  part = replaceOnce(part,
    "\t\tcontextWindowTokens: contextTokenBudget,\n\t\t...midTurnPrecheckOptions",
    "\t\tcontextWindowTokens: contextTokenBudget,\n\t\tisContextEngineAssemblyAuthoritative: () => contextEngineLoopAssemblyState?.succeeded === true && contextEngineLoopAssemblyState.promptAuthority !== \"preassembly_may_overflow\",\n\t\t...midTurnPrecheckOptions",
    "guard authority wiring");
  return part;
});
source = section(source, "function handleEmbeddedAttemptMidTurnPrecheck(input)", "async function prepareEmbeddedAttemptPromptPreflight(input)", (part) => replaceOnce(part,
  "\tif (request.route === \"truncate_tool_results_only\") {\n\t\tconst contextTokenBudget",
  "\tif (request.route === \"truncate_tool_results_only\") {\n\t\tif (input.contextEngineOwnsCompaction) {\n\t\t\tconst preflightRecovery = { route: \"compact_only\", source: \"mid-turn\", ...buildPreflightRecoveryBudgetSnapshot(request) };\n\t\t\tlogMidTurnPrecheck(\"compact_only\", \"engineOwnsCompaction=true\");\n\t\t\treturn { preflightRecovery, promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT) };\n\t\t}\n\t\tconst contextTokenBudget",
  "owning engine midturn routing"));
source = section(source, "const handleMidTurnPrecheckRequest = (request) => {", "const promptStartedAt = Date.now();", (part) => replaceOnce(part,
  "\t\t\tattempt,\n\t\t\trequest,\n\t\t\tsessionAgentId,",
  "\t\t\tattempt,\n\t\t\trequest,\n\t\t\tcontextEngineOwnsCompaction: activeContextEngine?.info.ownsCompaction === true,\n\t\t\tsessionAgentId,",
  "midturn engine owner"));
source = section(source, "async function submitEmbeddedAttemptPrompt(input)", "//#endregion", (part) => replaceOnce(part,
  "input.toolResultAggregateMaxChars, input.toolResultPromptProjectionState);",
  "input.toolResultAggregateMaxChars, input.toolResultPromptProjectionState, { protectTrailingToolResults: false });",
  "provider boundary fresh results"));
fs.writeFileSync(builtin, source);

const recovery = owner("async function recoverEmbeddedRunOverflow(input)");
let recoverySource = fs.readFileSync(recovery, "utf8");
recoverySource = section(recoverySource, "async function recoverEmbeddedRunOverflow(input)", "//#endregion", (part) => {
  part = replaceOnce(part,
    'if (preflightRecovery?.route === "compact_then_truncate") {',
    'if (preflightRecovery?.route === "compact_then_truncate" && input.contextEngine.info.ownsCompaction !== true) {',
    "post-compaction persistent truncation");
  return replaceOnce(part,
    "if (!parkedWorkBlocksContinuation && !input.state.toolResultTruncationAttempted) {",
    "if (!parkedWorkBlocksContinuation && input.contextEngine.info.ownsCompaction !== true && !input.state.toolResultTruncationAttempted) {",
    "fallback persistent truncation");
});
fs.writeFileSync(recovery, recoverySource);

const truncation = owner("function buildAggregateToolResultReplacements(");
let truncationSource = fs.readFileSync(truncation, "utf8");
truncationSource = section(truncationSource, "function truncateOversizedToolResultsInMessages(", "function resolveToolResultBudgets(", (part) => {
  part = replaceOnce(part,
    "aggregateMaxCharsOverride, projectionState) {",
    "aggregateMaxCharsOverride, projectionState, projectionOptions) {",
    "projection options parameter");
  return replaceOnce(part,
    "protectTrailingToolResults: Boolean(projectionState)",
    "protectTrailingToolResults: projectionOptions?.protectTrailingToolResults ?? Boolean(projectionState)",
    "frozen projection trailing results");
});
fs.writeFileSync(truncation, truncationSource);
