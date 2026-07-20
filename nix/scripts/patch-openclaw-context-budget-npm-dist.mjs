#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
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

const oldFormula =
  "const contextShareChars = Math.floor(contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);";
const patchedFormula =
  "const contextShareChars = Math.floor(contextWindowTokens * 2 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);";
const oldQuantumConstant = `const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = .5;
/**`;
const patchedQuantumConstant = `const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = .5;
const AGGREGATE_REDUCTION_QUANTUM_RATIO = .2;
/**`;
const oldLivePlan = `		minKeepChars: RECOVERY_MIN_KEEP_CHARS,
		protectTrailingToolResults: Boolean(projectionState)`;
const patchedLivePlan = `		minKeepChars: RECOVERY_MIN_KEEP_CHARS,
		aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO,
		protectTrailingToolResults: Boolean(projectionState)`;
const oldAggregateReduction =
  "let remainingReduction = totalChars - params.aggregateBudgetChars;";
const patchedAggregateReduction = `const aggregateOverflowChars = totalChars - params.aggregateBudgetChars;
	const aggregateReductionQuantumChars =
		params.aggregateReductionQuantumRatio !== void 0 &&
		params.aggregateBudgetChars >= MIN_KEEP_CHARS
			? Math.max(1, Math.ceil(params.aggregateBudgetChars * params.aggregateReductionQuantumRatio))
			: 1;
	let remainingReduction = Math.ceil(aggregateOverflowChars / aggregateReductionQuantumChars) * aggregateReductionQuantumChars;`;
const oldForwardedPlan = `		aggregateBudgetChars: params.aggregateBudgetChars,
		minKeepChars,
		protectTrailingToolResults: params.protectTrailingToolResults`;
const patchedForwardedPlan = `		aggregateBudgetChars: params.aggregateBudgetChars,
		minKeepChars,
		aggregateReductionQuantumRatio: params.aggregateReductionQuantumRatio,
		protectTrailingToolResults: params.protectTrailingToolResults`;
const oldEstimatePlan = `		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});`;
const patchedEstimatePlan = `		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS,
		aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO
	});`;
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(distDir, name))
  .filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes("function resolveLiveToolResultAggregateMaxChars") &&
      source.includes("function buildAggregateToolResultReplacements") &&
      (source.includes(oldFormula) || source.includes(patchedFormula))
    );
  });

if (candidates.length !== 1) {
  fail(`expected exactly one aggregate tool-result budget chunk, found ${candidates.length}`);
}

const target = candidates[0];
let source = fs.readFileSync(target, "utf8");
source = replaceExactlyOnce(
  source,
  oldFormula,
  patchedFormula,
  "aggregate tool-result budget formula",
);
source = replaceExactlyOnce(
  source,
  oldQuantumConstant,
  patchedQuantumConstant,
  "aggregate reduction quantum constant",
);
source = replaceExactlyOnce(
  source,
  oldLivePlan,
  patchedLivePlan,
  "live aggregate reduction quantum",
);
source = replaceExactlyOnce(
  source,
  oldAggregateReduction,
  patchedAggregateReduction,
  "aggregate reduction target",
);
source = replaceExactlyOnce(
  source,
  oldForwardedPlan,
  patchedForwardedPlan,
  "aggregate reduction quantum forwarding",
);
source = replaceExactlyOnce(
  source,
  oldEstimatePlan,
  patchedEstimatePlan,
  "aggregate reduction estimate quantum",
);

for (const [oldText, patchedText, label] of [
  [oldFormula, patchedFormula, "aggregate tool-result budget formula"],
  [oldQuantumConstant, patchedQuantumConstant, "aggregate reduction quantum constant"],
  [oldLivePlan, patchedLivePlan, "live aggregate reduction quantum"],
  [oldAggregateReduction, patchedAggregateReduction, "aggregate reduction target"],
  [oldForwardedPlan, patchedForwardedPlan, "aggregate reduction quantum forwarding"],
  [oldEstimatePlan, patchedEstimatePlan, "aggregate reduction estimate quantum"],
]) {
  if (!source.includes(patchedText) || source.includes(oldText)) {
    fail(`${label} was not patched completely`);
  }
}
fs.writeFileSync(target, source);
