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
function resolveLiveToolResultAggregateMaxChars(params) {
  const perResultMaxChars = Math.max(1, Math.floor(params.perResultMaxChars));
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextShareChars = Math.floor(contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);
  return Math.max(perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER, contextShareChars);
}
export { resolveLiveToolResultAggregateMaxChars };
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

test("aligns aggregate tool-result budget with the tool-loop estimator idempotently", async () => {
  const { root, target } = makeFixture();
  const first = runPatch(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runPatch(root);
  assert.equal(second.status, 0, second.stderr);

  const source = fs.readFileSync(target, "utf8");
  assert.match(source, /contextWindowTokens \* 2 \* AGGREGATE_TOOL_RESULT_CONTEXT_SHARE/);
  assert.doesNotMatch(source, /contextWindowTokens \* 4 \* AGGREGATE_TOOL_RESULT_CONTEXT_SHARE/);

  const module = await import(pathToFileURL(target).href);
  const aggregateMaxChars = module.resolveLiveToolResultAggregateMaxChars({
    contextWindowTokens: 372_000,
    perResultMaxChars: 64_000,
  });
  assert.equal(aggregateMaxChars, 372_000);
  assert.ok(aggregateMaxChars * 2 < 372_000 * 4 * 0.9);
});
