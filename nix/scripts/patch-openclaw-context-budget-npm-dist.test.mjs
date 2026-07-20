import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

const script = path.join(import.meta.dirname, "patch-openclaw-context-budget-npm-dist.mjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-budget-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const target = path.join(dist, "tool-result-truncation-fixture.js");
  fs.writeFileSync(
    target,
    `const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 4;
const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = .5;
/** fixture marker */
const MIN_KEEP_CHARS = 2e3;
const RECOVERY_MIN_KEEP_CHARS = 0;
function resolveLiveToolResultAggregateMaxChars(params) {
  const perResultMaxChars = Math.max(1, Math.floor(params.perResultMaxChars));
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextShareChars = Math.floor(contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);
  return Math.max(perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER, contextShareChars);
}
function buildAggregateToolResultReplacements(params) {
	const totalChars = params.totalChars;
	if (totalChars <= params.aggregateBudgetChars) return 0;
	let remainingReduction = totalChars - params.aggregateBudgetChars;
	return remainingReduction;
}
function buildToolResultReplacementPlan(params) {
	const minKeepChars = params.minKeepChars;
	const aggregatePlan = buildAggregateToolResultReplacements({
		totalChars: params.totalChars,
		aggregateBudgetChars: params.aggregateBudgetChars,
		minKeepChars,
		protectTrailingToolResults: params.protectTrailingToolResults
	});
	return aggregatePlan;
}
function truncateOversizedToolResultsInMessages(totalChars, aggregateBudgetChars, projectionState) {
	const plan = buildToolResultReplacementPlan({
		totalChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS,
		protectTrailingToolResults: Boolean(projectionState)
	});
	return plan;
}
function estimateToolResultReductionPotential(totalChars, aggregateBudgetChars) {
	const plan = buildToolResultReplacementPlan({
		totalChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	return plan;
}
function truncateOversizedToolResultsInSession(totalChars, aggregateBudgetChars) {
	return buildToolResultReplacementPlan({
		totalChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS,
		protectTrailingToolResults: false
	});
}
export {
  estimateToolResultReductionPotential,
  resolveLiveToolResultAggregateMaxChars,
  truncateOversizedToolResultsInMessages,
  truncateOversizedToolResultsInSession,
};
`,
  );
  return { root, target };
}

function runPatch(root) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("aligns the aggregate budget and applies chunked live recovery idempotently", async () => {
  const { root, target } = makeFixture();
  const first = runPatch(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runPatch(root);
  assert.equal(second.status, 0, second.stderr);

  const source = fs.readFileSync(target, "utf8");
  assert.match(source, /contextWindowTokens \* 2 \* AGGREGATE_TOOL_RESULT_CONTEXT_SHARE/);
  assert.doesNotMatch(source, /contextWindowTokens \* 4 \* AGGREGATE_TOOL_RESULT_CONTEXT_SHARE/);
  assert.match(source, /AGGREGATE_REDUCTION_QUANTUM_RATIO = \.2/);
  assert.match(source, /aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO/);
  assert.match(source, /aggregateOverflowChars \/ aggregateReductionQuantumChars/);

  const module = await import(pathToFileURL(target).href);
  const aggregateMaxChars = module.resolveLiveToolResultAggregateMaxChars({
    contextWindowTokens: 372_000,
    perResultMaxChars: 64_000,
  });
  assert.equal(aggregateMaxChars, 372_000);
  assert.ok(aggregateMaxChars * 2 < 372_000 * 4 * 0.9);

  assert.equal(module.truncateOversizedToolResultsInMessages(15_000, 12_000, {}), 4_800);
  assert.equal(module.estimateToolResultReductionPotential(15_000, 12_000), 4_800);
  assert.equal(module.truncateOversizedToolResultsInSession(15_000, 12_000), 3_000);
  assert.equal(module.truncateOversizedToolResultsInMessages(11_200, 12_000, {}), 0);
  assert.equal(module.truncateOversizedToolResultsInMessages(12_200, 12_000, {}), 2_400);
  assert.equal(module.truncateOversizedToolResultsInMessages(300, 94, {}), 206);
});
