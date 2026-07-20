import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const script = path.join(
  import.meta.dirname,
  "patch-openclaw-context-engine-tool-truncation-npm-dist.mjs",
);

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-engine-truncation-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  const runChunk = path.join(dist, "embedded-agent-fixture.js");
  const attemptChunk = path.join(dist, "selection-fixture.js");
  const truncationChunk = path.join(dist, "tool-result-truncation-fixture.js");
  fs.writeFileSync(
    runChunk,
    `if (compactResult.compacted) {
\t\t\t\t\t\t\t\tif (preflightRecovery?.route === "compact_then_truncate") {
\t\t\t\t\t\t\t\t\tconst truncResult = await truncateOversizedToolResultsInSession({});
\t\t\t\t\t\t\t\t\tif (truncResult.truncated) log$1.info(\`[context-overflow-precheck] post-compaction tool-result truncation succeeded for \${provider}/\${modelId}; truncated \${truncResult.truncatedCount} tool result(s)\`);
\t\t\t\t\t\t\t\t\telse log$1.warn(\`[context-overflow-precheck] post-compaction tool-result truncation did not help for \${provider}/\${modelId}: \${truncResult.reason ?? "unknown"}\`);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\tautoCompactionCount += 1;
}
if (hasOversized) {
\t\t\t\t\t\t\t\ttoolResultTruncationAttempted = true;
\t\t\t\t\t\t\t\tlog$1.warn(\`[context-overflow-recovery] Attempting tool result truncation for \${provider}/\${modelId} (contextWindow=\${contextWindowTokens} tokens)\`);
\t\t\t\t\t\t\t\tconst truncResult = await truncateOversizedToolResultsInSession({});
\t\t\t\t\t\t\t\tif (truncResult.truncated) continue;
\t\t\t\t\t\t\t\tlog$1.warn(\`[context-overflow-recovery] Tool result truncation did not help: \${truncResult.reason ?? "unknown"}\`);
\t\t\t\t\t\t\t}
`,
  );
  fs.writeFileSync(
    attemptChunk,
    `const promptToolResultTruncation = truncateOversizedToolResultsInMessages();
\t\t\t\t\tif (promptHistoryChanged) promptHistoryMessages = promptToolResultTruncation.messages;
if (aggregatePressureEngaged) {
\t\t\t\t\t\tconst sessionLogKey = params.sessionKey ?? params.sessionId ?? "unknown";
\t\t\t\t\t\t\t\tlog$2.warn(\`\${truncationLog}; aggregate tool-result pressure detected, compaction has been requested; consider /compact or /new if pressure persists\`);
\t\t\t\t\t\t\tpreflightRecovery = { route: "compact_then_truncate" };
\t\t\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
\t\t\t\t\t\t\tpromptErrorSource = "precheck";
\t\t\t\t\t\t\tskipPromptSubmission = true;
}
const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(messages, contextTokenBudget, promptToolResultMaxChars, promptToolResultAggregateMaxChars, toolResultPromptProjectionState);
`,
  );
  fs.writeFileSync(
    truncationChunk,
    `const AGGREGATE_REDUCTION_QUANTUM_RATIO = .2;
function truncateOversizedToolResultsInMessages(messages, contextWindowTokens, maxCharsOverride, aggregateMaxCharsOverride, projectionState) {
  return buildToolResultReplacementPlan({
    aggregateReductionQuantumRatio: AGGREGATE_REDUCTION_QUANTUM_RATIO,
    protectTrailingToolResults: Boolean(projectionState)
  });
}
`,
  );
  return { root, runChunk, attemptChunk, truncationChunk };
}

function runPatch(root) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("defers persistent truncation to engine-owned compaction idempotently", () => {
  const { root, runChunk, attemptChunk, truncationChunk } = makeFixture();
  const first = runPatch(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runPatch(root);
  assert.equal(second.status, 0, second.stderr);

  const runSource = fs.readFileSync(runChunk, "utf8");
  assert.match(runSource, /ownsCompaction !== true/);
  assert.match(runSource, /skipped persistent post-compaction/);
  assert.match(runSource, /Skipping persistent tool-result truncation/);

  const attemptSource = fs.readFileSync(attemptChunk, "utf8");
  assert.match(attemptSource, /contextEngineOwnsPromptCompaction/);
  assert.match(attemptSource, /handled by live prompt projection/);
  assert.match(attemptSource, /if \(!contextEngineOwnsPromptCompaction\)/);
  assert.match(attemptSource, /protectTrailingToolResults: !contextEngineOwnsPromptCompaction/);

  const truncationSource = fs.readFileSync(truncationChunk, "utf8");
  assert.match(truncationSource, /projectionState, projectionOptions/);
  assert.match(truncationSource, /projectionOptions\?\.protectTrailingToolResults/);
});
