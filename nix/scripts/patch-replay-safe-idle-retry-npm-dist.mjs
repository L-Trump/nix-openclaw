#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
const owners = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(dist, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes("async function recoverEmbeddedRunAttempt(input)"));
if (owners.length !== 1) {
  throw new Error(`expected one embedded recovery chunk, found ${owners.length}`);
}
const file = owners[0];
let source = fs.readFileSync(file, "utf8");
function replaceOnce(before, after, label) {
  const patched = source.split(after).length - 1;
  if (patched === 1) {
    return;
  }
  const found = source.split(before).length - 1;
  if (found !== 1 || patched !== 0) {
    throw new Error(`${label}: expected one original/patched match, found ${found}/${patched}`);
  }
  source = source.replace(before, after);
}
replaceOnce("const cap = options?.cap ?? 5;", "const cap = options?.cap ?? 7;", "idle breaker cap");
replaceOnce("(cap=5). Halting further attempts", "(cap=7). Halting further attempts", "idle breaker user diagnostic");
replaceOnce("consecutive=${breakerStep.consecutive} cap=5`", "consecutive=${breakerStep.consecutive} cap=7`", "idle breaker log diagnostic");
replaceOnce("let transientRetryCount = 0;", "let transientRetryCount = 0;\n\tlet sameModelIdleTimeoutRetries = 0;", "idle retry counter");
const retryMethod = `retrySilentIdleTimeout: async () => {
\t\t\tif (sameModelIdleTimeoutRetries >= 5) return false;
\t\t\tconst retryIndex = sameModelIdleTimeoutRetries;
\t\t\tconst backoffMs = Math.min(3e4, 2e3 * 2 ** retryIndex);
\t\t\tconst delayMs = Math.min(3e4, backoffMs + Math.floor(backoffMs * .1 * Math.random()));
\t\t\tlog$3.warn(\`[stream-retry] retrying replay-safe idle timeout on same model \${retryIndex + 1}/5 for \${sanitizeForLog(provider)}/\${sanitizeForLog(modelId)}: delayMs=\${delayMs}\`);
\t\t\tconst closeRetryWait = params.onRetryWait?.(Date.now() + delayMs, params.abortSignal);
\t\t\tlet completed = false;
\t\t\ttry {
\t\t\t\tawait sleepWithAbort(delayMs, params.abortSignal);
\t\t\t\tcompleted = true;
\t\t\t} finally { closeRetryWait?.(completed); }
\t\t\tsameModelIdleTimeoutRetries += 1;
\t\t\treturn true;
\t\t},`;
replaceOnce("\t\tsetTransientRetryBudget: (maxRetries) => {", `\t\t${retryMethod}\n\t\tsetTransientRetryBudget: (maxRetries) => {`, "replay-safe idle retry method");
const gate = `if (timedOut && idleTimedOut && currentAttemptReplaySafe && !hasAttemptTerminalState(attempt) && canRestartForLiveSwitch && !externalAbort && !signalOwnedInterruption && !timedOutDuringCompaction && !timedOutDuringToolExecution && !timedOutByRunBudget && !runtime.pluginHarnessOwnsTransport && !attempt.codexAppServerFailure && !attempt.yieldDetected && !attempt.clientToolCalls && !attempt.didSendDeterministicApprovalPrompt && !resolveReplayInvalidForAttempt(null) && await failoverRetryController.retrySilentIdleTimeout()) {
\t\trunInput.laneController.throwIfAborted();
\t\tsessionPromptState.markOwnedTranscriptRetry();
\t\treturn retry({ lastRetryFailoverReason: "timeout" });
\t}
\t`;
replaceOnce("\tconst recoveryReason = outputLimitFailure ? \"output_limit\" : failureReason;", `\tconst recoveryReason = outputLimitFailure ? "output_limit" : failureReason;\n\t${gate.trimEnd()}`, "silent idle priority");
fs.writeFileSync(file, source);
