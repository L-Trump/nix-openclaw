#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
const files = fs.readdirSync(dist)
  .filter((name) => /^tool-result-truncation-[\w-]+\.mjs$/.test(name))
  .map((name) => path.join(dist, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes("function buildAggregateToolResultReplacements("));
if (files.length !== 1) {
  throw new Error(`expected one aggregate planner chunk, found ${files.length}`);
}
const file = files[0];
let source = fs.readFileSync(file, "utf8");
function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count === 1) {
    source = source.replace(before, after);
  } else if (source.includes(after)) {
    return;
  } else {
    throw new Error(`${label}: expected one source match, found ${count}`);
  }
}
if (!source.includes("const AGGREGATE_REDUCTION_QUANTUM_RATIO = .2;")) {
  replaceOnce(
    "const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = .5;",
    "const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = .5;\nconst AGGREGATE_REDUCTION_QUANTUM_RATIO = .2;",
    "quantum constant",
  );
}
replaceOnce(
  "contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE",
  "contextWindowTokens * 2 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE",
  "aggregate density",
);
const quantumField = "aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO,";
const liveStart = source.indexOf("function truncateOversizedToolResultsInMessages(");
const liveEnd = source.indexOf("function resolveToolResultBudgets(", liveStart);
if (liveStart < 0 || liveEnd < liveStart) {
  throw new Error("live projection boundaries changed");
}
let live = source.slice(liveStart, liveEnd);
const liveNeedle = "minKeepChars: RECOVERY_MIN_KEEP_CHARS,\n\t\tprotectTrailingToolResults: Boolean(projectionState)";
if (live.includes(liveNeedle)) {
  live = live.replace(liveNeedle, `minKeepChars: RECOVERY_MIN_KEEP_CHARS,\n\t\t${quantumField}\n\t\tprotectTrailingToolResults: Boolean(projectionState)`);
} else if (!live.includes(quantumField)) {
  throw new Error("live projection plan changed");
}
source = source.slice(0, liveStart) + live + source.slice(liveEnd);
replaceOnce(
  "let remainingReduction = totalChars - params.aggregateBudgetChars;",
  `const overflowChars = totalChars - params.aggregateBudgetChars;
\tconst quantum = params.aggregateReductionQuantumRatio !== void 0 && params.aggregateBudgetChars >= MIN_KEEP_CHARS ? Math.max(1, Math.ceil(params.aggregateBudgetChars * params.aggregateReductionQuantumRatio)) : 1;
\tlet remainingReduction = Math.ceil(overflowChars / quantum) * quantum;`,
  "aggregate reduction quantum",
);
replaceOnce(
  "aggregateBudgetChars: params.aggregateBudgetChars,\n\t\tminKeepChars,\n\t\tprotectedEntryIds",
  "aggregateBudgetChars: params.aggregateBudgetChars,\n\t\tminKeepChars,\n\t\taggregateReductionQuantumRatio: params.aggregateReductionQuantumRatio,\n\t\tprotectedEntryIds",
  "aggregate planning propagation",
);
const estimateStart = source.indexOf("function estimateToolResultReductionPotential(");
const estimateEnd = source.indexOf("\nfunction ", estimateStart + 9);
if (estimateStart < 0 || estimateEnd < estimateStart) {
  throw new Error("reduction estimate boundaries changed");
}
let estimate = source.slice(estimateStart, estimateEnd);
const estimateNeedle = "aggregateBudgetChars,\n\t\tminKeepChars: RECOVERY_MIN_KEEP_CHARS\n\t});";
if (estimate.includes(estimateNeedle)) {
  estimate = estimate.replace(estimateNeedle, `aggregateBudgetChars,\n\t\tminKeepChars: RECOVERY_MIN_KEEP_CHARS,\n\t\t${quantumField}\n\t});`);
} else if (!estimate.includes(quantumField)) {
  throw new Error("reduction estimate plan changed");
}
source = source.slice(0, estimateStart) + estimate + source.slice(estimateEnd);
if (!source.includes("aggregateReductionQuantumRatio: params.aggregateReductionQuantumRatio") ||
    source.split(quantumField).length !== 3) {
  throw new Error("aggregate budget patch did not cover live and estimate paths");
}
fs.writeFileSync(file, source);
