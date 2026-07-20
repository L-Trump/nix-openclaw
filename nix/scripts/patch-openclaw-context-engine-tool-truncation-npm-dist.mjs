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

function findUniqueChunk(label, predicate) {
  const candidates = distFiles.filter((file) => predicate(fs.readFileSync(file, "utf8")));
  if (candidates.length !== 1) {
    fail(`expected exactly one ${label} chunk, found ${candidates.length}`);
  }
  return candidates[0];
}

const oldPostCompactCondition =
  'if (preflightRecovery?.route === "compact_then_truncate") {';
const patchedPostCompactCondition =
  'if (preflightRecovery?.route === "compact_then_truncate" && contextEngine.info.ownsCompaction !== true) {';
const oldPostCompactTail = lines(
  '\t\t\t\t\t\t\t\t\telse log$1.warn(`[context-overflow-precheck] post-compaction tool-result truncation did not help for ${provider}/${modelId}: ${truncResult.reason ?? "unknown"}`);',
  "\t\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t\t\tautoCompactionCount += 1;",
);
const patchedPostCompactTail = lines(
  '\t\t\t\t\t\t\t\t\telse log$1.warn(`[context-overflow-precheck] post-compaction tool-result truncation did not help for ${provider}/${modelId}: ${truncResult.reason ?? "unknown"}`);',
  "\t\t\t\t\t\t\t\t} else if (preflightRecovery?.route === \"compact_then_truncate\") log$1.info(`[context-overflow-precheck] skipped persistent post-compaction tool-result truncation for ${provider}/${modelId}: context engine owns compaction`);",
  "\t\t\t\t\t\t\t\tautoCompactionCount += 1;",
);
const oldFallbackStart = lines(
  "\t\t\t\t\t\t\t\ttoolResultTruncationAttempted = true;",
  '\t\t\t\t\t\t\t\tlog$1.warn(`[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} (contextWindow=${contextWindowTokens} tokens)`);',
);
const patchedFallbackStart = lines(
  "\t\t\t\t\t\t\t\ttoolResultTruncationAttempted = true;",
  '\t\t\t\t\t\t\t\tif (contextEngine.info.ownsCompaction === true) log$1.info(`[context-overflow-recovery] Skipping persistent tool-result truncation for ${provider}/${modelId}: context engine owns compaction and live prompt projection remains active`);',
  "\t\t\t\t\t\t\t\telse {",
  '\t\t\t\t\t\t\t\t\tlog$1.warn(`[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} (contextWindow=${contextWindowTokens} tokens)`);',
);
const oldFallbackTail = lines(
  '\t\t\t\t\t\t\t\tlog$1.warn(`[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`);',
  "\t\t\t\t\t\t\t}",
);
const patchedFallbackTail = lines(
  '\t\t\t\t\t\t\t\t\tlog$1.warn(`[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`);',
  "\t\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t\t}",
);

const runChunk = findUniqueChunk(
  "overflow recovery",
  (source) =>
    source.includes("post-compaction tool-result truncation succeeded") &&
    source.includes("Attempting tool result truncation for"),
);
let runSource = fs.readFileSync(runChunk, "utf8");
runSource = replaceExactlyOnce(
  runSource,
  oldPostCompactCondition,
  patchedPostCompactCondition,
  "engine-owned post-compaction truncation guard",
);
runSource = replaceExactlyOnce(
  runSource,
  oldPostCompactTail,
  patchedPostCompactTail,
  "engine-owned post-compaction truncation diagnostic",
);
runSource = replaceExactlyOnce(
  runSource,
  oldFallbackStart,
  patchedFallbackStart,
  "engine-owned fallback truncation guard",
);
runSource = replaceExactlyOnce(
  runSource,
  oldFallbackTail,
  patchedFallbackTail,
  "engine-owned fallback truncation closure",
);
fs.writeFileSync(runChunk, runSource);

const oldAggregateProjection =
  "\t\t\t\t\tif (promptHistoryChanged) promptHistoryMessages = promptToolResultTruncation.messages;";
const patchedAggregateProjection = lines(
  oldAggregateProjection,
  "\t\t\t\t\tconst contextEngineOwnsPromptCompaction = contextEngineAssemblySucceeded && activeContextEngine?.info.ownsCompaction === true;",
);
const oldAggregateWarning =
  '\t\t\t\t\t\t\t\tlog$2.warn(`${truncationLog}; aggregate tool-result pressure detected, compaction has been requested; consider /compact or /new if pressure persists`);';
const patchedAggregateWarning =
  '\t\t\t\t\t\t\t\tlog$2.warn(contextEngineOwnsPromptCompaction ? `${truncationLog}; aggregate tool-result pressure handled by live prompt projection because the context engine owns compaction` : `${truncationLog}; aggregate tool-result pressure detected, compaction has been requested; consider /compact or /new if pressure persists`);';
const oldAggregateRecovery = lines(
  '\t\t\t\t\t\t\tpreflightRecovery = { route: "compact_then_truncate" };',
  "\t\t\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);",
  '\t\t\t\t\t\t\tpromptErrorSource = "precheck";',
  "\t\t\t\t\t\t\tskipPromptSubmission = true;",
);
const patchedAggregateRecovery = lines(
  "\t\t\t\t\t\t\tif (!contextEngineOwnsPromptCompaction) {",
  '\t\t\t\t\t\t\t\tpreflightRecovery = { route: "compact_then_truncate" };',
  "\t\t\t\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);",
  '\t\t\t\t\t\t\t\tpromptErrorSource = "precheck";',
  "\t\t\t\t\t\t\t\tskipPromptSubmission = true;",
  "\t\t\t\t\t\t\t}",
);
const oldProviderProjection =
  "const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultAggregateMaxChars, toolResultPromptProjectionState);";
const patchedProviderProjection =
  "const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultAggregateMaxChars, toolResultPromptProjectionState, { protectTrailingToolResults: !contextEngineOwnsPromptCompaction });";

const attemptChunk = findUniqueChunk(
  "attempt aggregate pressure",
  (source) =>
    source.includes("const promptToolResultTruncation") &&
    source.includes("aggregate tool-result pressure detected, compaction has been requested"),
);
let attemptSource = fs.readFileSync(attemptChunk, "utf8");
attemptSource = replaceExactlyOnce(
  attemptSource,
  oldAggregateProjection,
  patchedAggregateProjection,
  "engine-owned aggregate pressure capability",
);
attemptSource = replaceExactlyOnce(
  attemptSource,
  oldAggregateWarning,
  patchedAggregateWarning,
  "engine-owned aggregate pressure diagnostic",
);
attemptSource = replaceExactlyOnce(
  attemptSource,
  oldAggregateRecovery,
  patchedAggregateRecovery,
  "engine-owned aggregate live projection",
);
attemptSource = replaceExactlyOnce(
  attemptSource,
  oldProviderProjection,
  patchedProviderProjection,
  "engine-owned provider boundary projection",
);
fs.writeFileSync(attemptChunk, attemptSource);

const oldProjectionSignature =
  "function truncateOversizedToolResultsInMessages(messages, contextWindowTokens, maxCharsOverride, aggregateMaxCharsOverride, projectionState) {";
const patchedProjectionSignature =
  "function truncateOversizedToolResultsInMessages(messages, contextWindowTokens, maxCharsOverride, aggregateMaxCharsOverride, projectionState, projectionOptions) {";
const oldTrailingProtection = "protectTrailingToolResults: Boolean(projectionState)";
const patchedTrailingProtection =
  "protectTrailingToolResults: projectionOptions?.protectTrailingToolResults ?? Boolean(projectionState)";

const truncationChunk = findUniqueChunk(
  "tool-result live projection",
  (source) =>
    source.includes("function truncateOversizedToolResultsInMessages") &&
    source.includes("aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO"),
);
let truncationSource = fs.readFileSync(truncationChunk, "utf8");
truncationSource = replaceExactlyOnce(
  truncationSource,
  oldProjectionSignature,
  patchedProjectionSignature,
  "provider projection options parameter",
);
truncationSource = replaceExactlyOnce(
  truncationSource,
  oldTrailingProtection,
  patchedTrailingProtection,
  "provider projection trailing protection override",
);
fs.writeFileSync(truncationChunk, truncationSource);

for (const [source, markers, label] of [
  [
    runSource,
    [
      patchedPostCompactCondition,
      "skipped persistent post-compaction tool-result truncation",
      "Skipping persistent tool-result truncation",
    ],
    "overflow recovery",
  ],
  [
    attemptSource,
    [
      "const contextEngineOwnsPromptCompaction =",
      "aggregate tool-result pressure handled by live prompt projection",
      "if (!contextEngineOwnsPromptCompaction)",
      "protectTrailingToolResults: !contextEngineOwnsPromptCompaction",
    ],
    "attempt aggregate pressure",
  ],
  [
    truncationSource,
    [
      "projectionState, projectionOptions",
      "projectionOptions?.protectTrailingToolResults ?? Boolean(projectionState)",
    ],
    "tool-result live projection",
  ],
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      fail(`${label} patch marker missing: ${marker}`);
    }
  }
}
