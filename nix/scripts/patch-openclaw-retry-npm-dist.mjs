#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, source) {
  fs.writeFileSync(file, source);
}

function replaceOnce(source, search, replacement, description) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    fail(`${description}: expected exactly one match, found ${count}`);
  }
  return source.replace(search, replacement);
}

function findSingleDistFile(distDir, predicate, description) {
  const files = fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(distDir, name))
    .filter((file) => predicate(readText(file)));

  if (files.length !== 1) {
    fail(`expected exactly one ${description}, found ${files.length}`);
  }
  return files[0];
}

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  fail("OPENCLAW_PACKAGE_ROOT is required");
}

const distDir = path.join(root, "dist");
if (!fs.existsSync(distDir)) {
  fail(`OpenClaw dist directory missing: ${distDir}`);
}

// Provider SDK request retries. Keep an explicit settings.json override authoritative,
// but use Codex's request_max_retries=4 when the agent has no local override.
const sessionsFile = findSingleDistFile(
  distDir,
  (candidate) =>
    candidate.includes("getProviderRetrySettings()") &&
    candidate.includes("this.settings.retry?.provider?.maxRetryDelayMs"),
  "agent sessions settings chunk",
);
let source = readText(sessionsFile);
const providerRetryDefault =
  "maxRetries: this.settings.retry?.provider?.maxRetries ?? 4";
if (!source.includes(providerRetryDefault)) {
  source = replaceOnce(
    source,
    "maxRetries: this.settings.retry?.provider?.maxRetries,",
    `${providerRetryDefault},`,
    "provider request retry default patch",
  );
}
if (!source.includes(providerRetryDefault)) {
  fail("agent sessions settings chunk did not receive the provider retry default patch");
}
writeText(sessionsFile, source);

// Codex waits up to 300 seconds for stream progress. Explicit provider/run/agent
// timeouts remain ceilings, and OpenClaw's shorter cron timeout remains unchanged.
const timeoutFile = findSingleDistFile(
  distDir,
  (candidate) => candidate.includes("function resolveLlmIdleTimeoutMs"),
  "LLM idle timeout chunk",
);
source = readText(timeoutFile);
if (!source.includes("const DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5;")) {
  source = replaceOnce(
    source,
    "const DEFAULT_LLM_IDLE_TIMEOUT_MS = 12e4;",
    "const DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5;",
    "cloud LLM idle timeout patch",
  );
}
if (!source.includes("const DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5;")) {
  fail("LLM timeout chunk did not receive the 300 second cloud idle timeout patch");
}
writeText(timeoutFile, source);

// Mid-stream recovery stays deliberately narrower than provider request retry:
// retry only a silent idle timeout that OpenClaw proves replay-safe (no text,
// tool calls, delivery, approval prompt, compaction/tool timeout, or invalid replay
// metadata). Retry the current model before rotating profiles/falling back.
const embeddedAgentFile = findSingleDistFile(
  distDir,
  (candidate) =>
    candidate.includes("MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES") &&
    candidate.includes("allowSameModelIdleTimeoutRetry") &&
    candidate.includes("sameModelIdleTimeoutRetries += 1") &&
    candidate.includes("canRestartForLiveSwitch"),
  "embedded agent retry orchestration chunk",
);
source = readText(embeddedAgentFile);

// Raise the no-progress circuit breaker enough to admit the initial request,
// five same-model retries, and one existing profile/fallback transition attempt.
// It still bounds profile fan-out and paid calls. Rollup inlines the exported
// source constant into the helper and both diagnostic strings.
if (!source.includes("const cap = options?.cap ?? 7;")) {
  source = replaceOnce(
    source,
    "const cap = options?.cap ?? 5;",
    "const cap = options?.cap ?? 7;",
    "idle timeout breaker cap patch",
  );
}
if (!source.includes("(cap=7). Halting further attempts")) {
  source = replaceOnce(
    source,
    "(cap=5). Halting further attempts",
    "(cap=7). Halting further attempts",
    "idle timeout breaker user diagnostic patch",
  );
}
if (!source.includes("consecutive=${breakerStep.consecutive} cap=7`")) {
  source = replaceOnce(
    source,
    "consecutive=${breakerStep.consecutive} cap=5`",
    "consecutive=${breakerStep.consecutive} cap=7`",
    "idle timeout breaker log diagnostic patch",
  );
}

const streamRetryConstants = `const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 5;
const SAME_MODEL_IDLE_TIMEOUT_RETRY_BASE_DELAY_MS = 2e3;
const SAME_MODEL_IDLE_TIMEOUT_RETRY_MAX_DELAY_MS = 3e4;
function resolveSameModelIdleTimeoutRetryDelayMs(retriesSoFar) {
\tconst retryIndex = Math.max(0, Math.floor(retriesSoFar));
\tconst exponentialDelayMs = SAME_MODEL_IDLE_TIMEOUT_RETRY_BASE_DELAY_MS * 2 ** retryIndex;
\tconst cappedDelayMs = Math.min(SAME_MODEL_IDLE_TIMEOUT_RETRY_MAX_DELAY_MS, exponentialDelayMs);
\tconst positiveJitterMs = Math.floor(cappedDelayMs * .1 * Math.random());
\treturn Math.min(SAME_MODEL_IDLE_TIMEOUT_RETRY_MAX_DELAY_MS, cappedDelayMs + positiveJitterMs);
}`;
if (!source.includes("function resolveSameModelIdleTimeoutRetryDelayMs")) {
  source = replaceOnce(
    source,
    "const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;",
    streamRetryConstants,
    "Codex-style stream retry constants patch",
  );
}

const retryBeforeProfileRotationMarker =
  "// Local Codex-style policy: exhaust replay-safe same-model idle retries before profile rotation or model fallback.";
if (!source.includes(retryBeforeProfileRotationMarker)) {
  source = replaceOnce(
    source,
    `\tif (decision.action === "rotate_profile") {`,
    `\t${retryBeforeProfileRotationMarker}
\tif (params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) return sameModelIdleTimeoutRetry();
\tif (decision.action === "rotate_profile") {`,
    "same-model retry before profile rotation patch",
  );
}

const replaySafeRetryGate =
  "allowSameModelIdleTimeoutRetry: timedOut && idleTimedOut && !externalAbort && !timedOutDuringCompaction && !timedOutDuringToolExecution && !timedOutByRunBudget && !pluginHarnessOwnsTransport && !hasAttemptTerminalState(attempt) && attempt.replayMetadata.replaySafe && resolveReplayInvalidForAttempt(null) !== true && canRestartForLiveSwitch && sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES";
if (!source.includes(replaySafeRetryGate)) {
  source = replaceOnce(
    source,
    "allowSameModelIdleTimeoutRetry: timedOut && idleTimedOut && !timedOutDuringCompaction && !fallbackConfigured && canRestartForLiveSwitch && sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES",
    replaySafeRetryGate,
    "replay-safe stream retry gate patch",
  );
}

const streamRetryBackoffBlock = `if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") {
\t\t\t\t\t\t\tconst delayMs = resolveSameModelIdleTimeoutRetryDelayMs(sameModelIdleTimeoutRetries);
\t\t\t\t\t\t\tlog$1.warn(\`[stream-retry] retrying replay-safe idle timeout on same model \${sameModelIdleTimeoutRetries + 1}/\${MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES} for \${sanitizeForLog(provider)}/\${sanitizeForLog(modelId)}: delayMs=\${delayMs}\`);
\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\tawait sleepWithAbort(delayMs, params.abortSignal);
\t\t\t\t\t\t\t} catch (err) {
\t\t\t\t\t\t\t\tif (params.abortSignal?.aborted) {
\t\t\t\t\t\t\t\t\tconst abortErr = new Error("Operation aborted", { cause: err });
\t\t\t\t\t\t\t\t\tabortErr.name = "AbortError";
\t\t\t\t\t\t\t\t\tthrow abortErr;
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\tthrow err;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tsameModelIdleTimeoutRetries += 1;
\t\t\t\t\t\t}`;
if (!source.includes("[stream-retry] retrying replay-safe idle timeout on same model")) {
  source = replaceOnce(
    source,
    `if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") sameModelIdleTimeoutRetries += 1;`,
    streamRetryBackoffBlock,
    "stream retry exponential backoff patch",
  );
}

for (const marker of [
  "const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 5;",
  "function resolveSameModelIdleTimeoutRetryDelayMs",
  "const cap = options?.cap ?? 7;",
  "(cap=7). Halting further attempts",
  "consecutive=${breakerStep.consecutive} cap=7`",
  retryBeforeProfileRotationMarker,
  replaySafeRetryGate,
  "[stream-retry] retrying replay-safe idle timeout on same model",
]) {
  if (!source.includes(marker)) {
    fail(`embedded agent chunk did not receive retry patch marker: ${marker}`);
  }
}
if (source.includes("!timedOutDuringCompaction && !fallbackConfigured && canRestartForLiveSwitch")) {
  fail("embedded agent chunk still blocks replay-safe retries when a fallback is configured");
}
writeText(embeddedAgentFile, source);
