import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const script = path.join(import.meta.dirname, "patch-openclaw-retry-npm-dist.mjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retry-dist-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);

  const sessionsPath = path.join(dist, "sessions-fixture.js");
  fs.writeFileSync(
    sessionsPath,
    `class SettingsManager {
\tgetProviderRetrySettings() {
\t\treturn {
\t\t\ttimeoutMs: this.settings.retry?.provider?.timeoutMs,
\t\t\tmaxRetries: this.settings.retry?.provider?.maxRetries,
\t\t\tmaxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 6e4
\t\t};
\t}
}
`,
  );

  const timeoutPath = path.join(dist, "selection-fixture.js");
  fs.writeFileSync(
    timeoutPath,
    `const DEFAULT_LLM_IDLE_TIMEOUT_MS = 12e4;
function resolveLlmIdleTimeoutMs() { return DEFAULT_LLM_IDLE_TIMEOUT_MS; }
`,
  );

  const embeddedPath = path.join(dist, "embedded-agent-fixture.js");
  fs.writeFileSync(
    embeddedPath,
    `function stepIdleTimeoutBreaker(state, input, options) {
\tconst cap = options?.cap ?? 5;
\treturn { tripped: cap > 0 };
}
const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;
async function handleAssistantFailover(params) {
\tlet overloadProfileRotations = params.overloadProfileRotations;
\tlet decision = params.initialDecision;
\tconst sameModelIdleTimeoutRetry = () => ({ action: "retry", retryKind: "same_model_idle_timeout" });
\tconst sameModelRateLimitRetry = () => ({
\t\taction: "retry",
\t\toverloadProfileRotations,
\t\tretryKind: "same_model_rate_limit",
\t\tlastRetryFailoverReason: mergeRetryFailoverReason({
\t\t\tprevious: params.previousRetryFailoverReason,
\t\t\tfailoverReason: params.failoverReason,
\t\t\ttimedOut: params.timedOut || params.idleTimedOut
\t\t})
\t});
\tif (decision.action === "rotate_profile") {
\t\treturn sameModelRateLimitRetry();
\t}
}
async function run() {
\tconst canRestartForLiveSwitch = true;
\tconst breakerMessage = "Idle-timeout cost-runaway breaker tripped: " + breakerStep.consecutive + " consecutive idle timeouts without completed model progress (cap=5). Halting further attempts to bound paid model calls. See issue #76293.";
\tlog.error(\`[idle-timeout-circuit-breaker-tripped] sessionKey=\${params.sessionKey} consecutive=\${breakerStep.consecutive} cap=5\`);
\t\t\t\t\tconst assistantFailoverDecision = resolveRunFailoverDecision({
\t\t\t\t\t\ttimedOutByRunBudget,
\t\t\t\t\t\tprofileRotated: false
\t\t\t\t\t});
\t\t\t\t\tconst assistantFailoverOutcome = await handleAssistantFailover({});
\tconst allow = { allowSameModelIdleTimeoutRetry: timedOut && idleTimedOut && !timedOutDuringCompaction && !fallbackConfigured && canRestartForLiveSwitch && sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES };
\tif (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") sameModelIdleTimeoutRetries += 1;
}
`,
  );
  return { root, sessionsPath, timeoutPath, embeddedPath };
}

function runPatch(root) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("adds bounded Codex-style request and replay-safe stream retries idempotently", () => {
  const { root, sessionsPath, timeoutPath, embeddedPath } = makeFixture();

  const first = runPatch(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runPatch(root);
  assert.equal(second.status, 0, second.stderr);

  const sessions = fs.readFileSync(sessionsPath, "utf8");
  assert.match(sessions, /maxRetries: this\.settings\.retry\?\.provider\?\.maxRetries \?\? 4/);
  assert.match(sessions, /maxRetryDelayMs: this\.settings\.retry\?\.provider\?\.maxRetryDelayMs \?\? 6e4/);

  const timeout = fs.readFileSync(timeoutPath, "utf8");
  assert.match(timeout, /DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5/);

  const embedded = fs.readFileSync(embeddedPath, "utf8");
  assert.match(embedded, /const cap = options\?\.cap \?\? 7/);
  assert.match(embedded, /\(cap=7\)\. Halting further attempts/);
  assert.match(embedded, /MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 5/);
  assert.match(embedded, /SAME_MODEL_IDLE_TIMEOUT_RETRY_BASE_DELAY_MS = 2e3/);
  assert.match(embedded, /SAME_MODEL_IDLE_TIMEOUT_RETRY_MAX_DELAY_MS = 3e4/);
  assert.match(embedded, /resolveSameModelIdleTimeoutRetryDelayMs/);
  assert.match(embedded, /await sleepWithAbort\(delayMs, params\.abortSignal\)/);
  assert.match(embedded, /retrying replay-safe idle timeout on same model/);
  for (const safetyCondition of [
    "!externalAbort",
    "!timedOutDuringCompaction",
    "!timedOutDuringToolExecution",
    "!timedOutByRunBudget",
    "!pluginHarnessOwnsTransport",
    "!hasAttemptTerminalState(attempt)",
    "attempt.replayMetadata.replaySafe",
    "resolveReplayInvalidForAttempt(null) !== true",
    "canRestartForLiveSwitch",
  ]) {
    assert.ok(embedded.includes(safetyCondition), `missing retry safety condition: ${safetyCondition}`);
  }
  assert.ok(
    embedded.indexOf("Local Codex-style policy") <
      embedded.indexOf('if (decision.action === "rotate_profile")'),
    "same-model idle retry must be evaluated before profile rotation",
  );
  assert.doesNotMatch(embedded, /!fallbackConfigured/);

  const gateExpression = embedded.match(/allowSameModelIdleTimeoutRetry: ([^,}\n]+)/)?.[1];
  assert.ok(gateExpression, "retry gate expression not found");
  const evaluateGate = (overrides = {}) => {
    const gateContext = {
      timedOut: true,
      idleTimedOut: true,
      externalAbort: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      timedOutByRunBudget: false,
      pluginHarnessOwnsTransport: false,
      attempt: { replayMetadata: { replaySafe: true } },
      hasAttemptTerminalState: () => false,
      resolveReplayInvalidForAttempt: () => false,
      canRestartForLiveSwitch: true,
      sameModelIdleTimeoutRetries: 0,
      MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES: 5,
      ...overrides,
    };
    return vm.runInNewContext(`Boolean(${gateExpression})`, gateContext);
  };
  assert.equal(evaluateGate(), true);
  for (const unsafeOverride of [
    { externalAbort: true },
    { timedOutDuringCompaction: true },
    { timedOutDuringToolExecution: true },
    { timedOutByRunBudget: true },
    { pluginHarnessOwnsTransport: true },
    { hasAttemptTerminalState: () => true },
    { attempt: { replayMetadata: { replaySafe: false } } },
    { resolveReplayInvalidForAttempt: () => true },
    { canRestartForLiveSwitch: false },
    { sameModelIdleTimeoutRetries: 5 },
  ]) {
    assert.equal(evaluateGate(unsafeOverride), false);
  }

  const context = { Math: Object.create(Math) };
  context.Math.random = () => 0;
  vm.runInNewContext(
    `${embedded}\nglobalThis.resolveRetryDelay = resolveSameModelIdleTimeoutRetryDelayMs;`,
    context,
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((attempt) => context.resolveRetryDelay(attempt)),
    [2_000, 4_000, 8_000, 16_000, 30_000],
  );
});
