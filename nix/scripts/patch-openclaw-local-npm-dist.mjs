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

function findSingleDistFile(distDir, pattern, predicate, description) {
  const files = fs
    .readdirSync(distDir)
    .filter((name) => pattern.test(name))
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

const thinkingFile = findSingleDistFile(
  distDir,
  /^thinking-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("function catalogSupportsXHigh") &&
    candidate.includes("function resolveThinkingProfile") &&
    candidate.includes("compat?.supportedReasoningEfforts"),
  "thinking profile catalog chunk",
);
let source = readText(thinkingFile);

if (!source.includes("function catalogSupportsMax")) {
  source = replaceOnce(
    source,
    `function catalogSupportsXHigh(compat) {
\tconst efforts = compat?.supportedReasoningEfforts;
\tif (!Array.isArray(efforts)) return false;
\treturn efforts.some((effort) => normalizeThinkLevel(effort) === "xhigh");
}`,
    `function catalogSupportsXHigh(compat) {
\tconst efforts = compat?.supportedReasoningEfforts;
\tif (!Array.isArray(efforts)) return false;
\treturn efforts.some((effort) => normalizeThinkLevel(effort) === "xhigh");
}
function catalogSupportsMax(compat) {
\tconst efforts = compat?.supportedReasoningEfforts;
\tif (!Array.isArray(efforts)) return false;
\treturn efforts.some((effort) => normalizeThinkLevel(effort) === "max");
}`,
    "catalog max reasoning effort helper insertion",
  );
}

if (
  !source.includes(
    'if (binaryDecision !== true && catalogSupportsMax(context.compat)) appendProfileLevel(profile, "max");',
  )
) {
  source = replaceOnce(
    source,
    `if (binaryDecision !== true && catalogSupportsXHigh(context.compat)) appendProfileLevel(profile, "xhigh");`,
    `if (binaryDecision !== true && catalogSupportsXHigh(context.compat)) appendProfileLevel(profile, "xhigh");
\tif (binaryDecision !== true && catalogSupportsMax(context.compat)) appendProfileLevel(profile, "max");`,
    "catalog max reasoning effort profile insertion",
  );
}

if (!source.includes("function catalogSupportsMax")) {
  fail("thinking profile chunk did not receive catalog max helper patch");
}
if (
  !source.includes(
    'if (binaryDecision !== true && catalogSupportsMax(context.compat)) appendProfileLevel(profile, "max");',
  )
) {
  fail("thinking profile chunk did not receive catalog max level patch");
}
writeText(thinkingFile, source);

const toolsFile = findSingleDistFile(
  distDir,
  /^openclaw-tools-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("//#region src/agents/tools/sessions-send-tool.ts") &&
    candidate.includes("const SessionsSendToolSchema = Type.Object") &&
    candidate.includes("message: Type.String()"),
  "openclaw tools sessions_send chunk",
);
source = readText(toolsFile);

if (!source.includes("minLength: 0")) {
  source = replaceOnce(
    source,
    `\tlabel: Type.Optional(Type.String({
\t\tminLength: 1,
\t\tmaxLength: 512
\t})),
\tagentId: Type.Optional(Type.String({
\t\tminLength: 1,
\t\tmaxLength: 64
\t})),`,
    `\tlabel: Type.Optional(Type.String({
\t\tminLength: 0,
\t\tmaxLength: 512
\t})),
\tagentId: Type.Optional(Type.String({
\t\tminLength: 0,
\t\tmaxLength: 64
\t})),`,
    "sessions_send empty selector schema patch",
  );
}

if (!source.includes("minLength: 0")) {
  fail("sessions_send empty selector schema patch was not applied");
}
writeText(toolsFile, source);


const openAIStreamWrapperFile = findSingleDistFile(
  distDir,
  /^[A-Za-z0-9_.-]+\.js$/,
  (candidate) =>
    candidate.includes("function shouldApplyOpenAIReasoningCompatibility") &&
    candidate.includes("function shouldApplyOpenAIServiceTier") &&
    candidate.includes("function createOpenAIFastModeWrapper"),
  "OpenAI stream wrapper chunk",
);
source = readText(openAIStreamWrapperFile);

if (!source.includes("function isRhcgOpenAICompatibleFastReasoningModel")) {
  source = replaceOnce(
    source,
    `function shouldApplyOpenAIServiceTier(model) {
	return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier;
}`,
    `function isRhcgOpenAICompatibleFastReasoningModel(model) {
	return model.provider === "rhcg" && (model.api === "openai-completions" || model.api === "openai-responses");
}
function shouldApplyOpenAIServiceTier(model) {
	if (isRhcgOpenAICompatibleFastReasoningModel(model)) return true;
	return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier;
}`,
    "RHCG OpenAI-compatible service_tier opt-in patch",
  );
}

if (!source.includes(`if (isRhcgOpenAICompatibleFastReasoningModel(model)) return true;
	return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;`)) {
  source = replaceOnce(
    source,
    `	return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;`,
    `	if (isRhcgOpenAICompatibleFastReasoningModel(model)) return true;
	return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;`,
    "RHCG OpenAI-compatible reasoning payload opt-in patch",
  );
}

if (!source.includes('!isRhcgOpenAICompatibleFastReasoningModel(model)')) {
  if (source.includes('if (normalizeOpenAIFastMode(enabled) !== true || model.api !== "openai-responses" && model.api !== "openai-chatgpt-responses" && model.api !== "azure-openai-responses" || model.provider !== "openai") return underlying(model, context, options);')) {
    source = replaceOnce(
      source,
      `if (normalizeOpenAIFastMode(enabled) !== true || model.api !== "openai-responses" && model.api !== "openai-chatgpt-responses" && model.api !== "azure-openai-responses" || model.provider !== "openai") return underlying(model, context, options);`,
      `if (normalizeOpenAIFastMode(enabled) !== true || !isRhcgOpenAICompatibleFastReasoningModel(model) && (model.api !== "openai-responses" && model.api !== "openai-chatgpt-responses" && model.api !== "azure-openai-responses" || model.provider !== "openai")) return underlying(model, context, options);`,
      "RHCG OpenAI-compatible fast mode wrapper minified gate patch",
    );
  } else {
    source = replaceOnce(
      source,
      `			normalizeOpenAIFastMode(enabled) !== true ||
			(model.api !== "openai-responses" &&
				model.api !== "openai-chatgpt-responses" &&
				model.api !== "azure-openai-responses") ||
			model.provider !== "openai"
		) {`,
      `			normalizeOpenAIFastMode(enabled) !== true ||
			(!isRhcgOpenAICompatibleFastReasoningModel(model) &&
				((model.api !== "openai-responses" &&
					model.api !== "openai-chatgpt-responses" &&
					model.api !== "azure-openai-responses") ||
					model.provider !== "openai"))
		) {`,
      "RHCG OpenAI-compatible fast mode wrapper gate patch",
    );
  }
}

if (!source.includes("function isRhcgOpenAICompatibleFastReasoningModel")) {
  fail("OpenAI wrapper chunk did not receive RHCG helper patch");
}
if (!source.includes(`if (isRhcgOpenAICompatibleFastReasoningModel(model)) return true;
	return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;`)) {
  fail("OpenAI wrapper chunk did not receive RHCG reasoning payload patch");
}
if (!source.includes('!isRhcgOpenAICompatibleFastReasoningModel(model)')) {
  fail("OpenAI wrapper chunk did not receive RHCG fast mode gate patch");
}
writeText(openAIStreamWrapperFile, source);

const openAICompletionsTransportFile = findSingleDistFile(
  distDir,
  /^[A-Za-z0-9_.-]+\.js$/,
  (candidate) =>
    candidate.includes("function buildOpenAICompletionsParams") &&
    candidate.includes("function createOpenAICompletionsTransportStreamFn") &&
    candidate.includes("params.reasoning_effort = resolvedCompletionsReasoningEffort"),
  "OpenAI completions transport chunk",
);
source = readText(openAICompletionsTransportFile);

if (!source.includes("function shouldApplyRhcgOpenAICompletionsServiceTier")) {
  source = replaceOnce(
    source,
    `function buildOpenAICompletionsParams(model, context, options) {`,
    `function shouldApplyRhcgOpenAICompletionsServiceTier(model) {
	return model.provider === "rhcg" && model.api === "openai-completions";
}
function normalizeOpenAICompletionsServiceTier(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "default" || normalized === "flex" || normalized === "priority") return normalized;
}
function normalizeOpenAICompletionsFastMode(value) {
	if (typeof value === "function") return normalizeOpenAICompletionsFastMode(value());
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto") return;
	if (normalized === "on" || normalized === "true" || normalized === "yes" || normalized === "1" || normalized === "fast") return true;
	if (normalized === "off" || normalized === "false" || normalized === "no" || normalized === "0" || normalized === "normal") return false;
}
function resolveRhcgOpenAICompletionsServiceTier(options) {
	const explicit = normalizeOpenAICompletionsServiceTier(options?.serviceTier ?? options?.service_tier);
	if (explicit !== void 0) return explicit;
	return normalizeOpenAICompletionsFastMode(options?.fastMode ?? options?.fast_mode) === true ? "priority" : void 0;
}
function buildOpenAICompletionsParams(model, context, options) {`,
    "RHCG OpenAI completions service_tier helper insertion",
  );
}

if (!source.includes("const completionsServiceTier = resolveRhcgOpenAICompletionsServiceTier(options);")) {
  source = replaceOnce(
    source,
    `	if (compat.supportsPromptCacheKey && promptCacheKey) {
		params.prompt_cache_key = promptCacheKey;
		if (cacheRetention === "long" && compat.supportsLongCacheRetention) params.prompt_cache_retention = "24h";
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;`,
    `	if (compat.supportsPromptCacheKey && promptCacheKey) {
		params.prompt_cache_key = promptCacheKey;
		if (cacheRetention === "long" && compat.supportsLongCacheRetention) params.prompt_cache_retention = "24h";
	}
	if (shouldApplyRhcgOpenAICompletionsServiceTier(model)) {
		const completionsServiceTier = resolveRhcgOpenAICompletionsServiceTier(options);
		if (completionsServiceTier !== void 0) params.service_tier = completionsServiceTier;
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;`,
    "RHCG OpenAI completions service_tier payload insertion",
  );
}

if (!source.includes("function shouldApplyRhcgOpenAICompletionsServiceTier")) {
  fail("OpenAI completions transport chunk did not receive RHCG service_tier helper patch");
}
if (!source.includes("params.service_tier = completionsServiceTier")) {
  fail("OpenAI completions transport chunk did not receive RHCG service_tier payload patch");
}
writeText(openAICompletionsTransportFile, source);

const extraParamsFile = findSingleDistFile(
  distDir,
  /^[A-Za-z0-9_.-]+\.js$/,
  (candidate) =>
    candidate.includes("function createStreamFnWithExtraParams") &&
    candidate.includes("function applyExtraParamsToAgent") &&
    candidate.includes("const resolvedStop = normalizeStopSequences(extraParams.stop)"),
  "embedded agent extra params stream wrapper chunk",
);
source = readText(extraParamsFile);

if (!source.includes("streamParams.fastMode = resolvedFastMode")) {
  source = replaceOnce(
    source,
    `	const resolvedStop = normalizeStopSequences(extraParams.stop);
	if (resolvedStop) streamParams.stop = resolvedStop;`,
    `	const resolvedStop = normalizeStopSequences(extraParams.stop);
	if (resolvedStop) streamParams.stop = resolvedStop;
	const resolvedFastMode = resolveAliasedParamValueFromKeys([extraParams], ["fastMode", "fast_mode"]);
	if (resolvedFastMode !== void 0) streamParams.fastMode = resolvedFastMode;
	const resolvedServiceTier = resolveAliasedParamValueFromKeys([extraParams], ["serviceTier", "service_tier"]);
	if (resolvedServiceTier !== void 0) streamParams.serviceTier = resolvedServiceTier;`,
    "fast mode/service tier extra params forwarding patch",
  );
}

if (!source.includes("streamParams.fastMode = resolvedFastMode")) {
  fail("extra params chunk did not receive fastMode forwarding patch");
}
if (!source.includes("streamParams.serviceTier = resolvedServiceTier")) {
  fail("extra params chunk did not receive serviceTier forwarding patch");
}
writeText(extraParamsFile, source);

const controlUiAssetsDir = path.join(distDir, "control-ui", "assets");
if (!fs.existsSync(controlUiAssetsDir)) {
  fail(`OpenClaw Control UI assets directory missing: ${controlUiAssetsDir}`);
}
const controlUiIndexFile = findSingleDistFile(
  controlUiAssetsDir,
  /^(?:index|chat-page)-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("data-chat-speed-option") &&
    candidate.includes("minimax-portal") &&
    candidate.includes("openrouter") &&
    candidate.includes("xai"),
  "Control UI chat speed selector chunk",
);
source = readText(controlUiIndexFile);

const minifiedFastModeProviderSet =
  "new Set([`anthropic`,`minimax`,`minimax-portal`,`openai`,`openrouter`,`xai`])";
const patchedMinifiedFastModeProviderSet =
  "new Set([`anthropic`,`minimax`,`minimax-portal`,`openai`,`openrouter`,`rhcg`,`xai`])";
const sourceFastModeProviderSet = `const FAST_MODE_PROVIDER_IDS = new Set([
  "anthropic",
  "minimax",
  "minimax-portal",
  "openai",
  "openrouter",
  "xai",
]);`;
const patchedSourceFastModeProviderSet = `const FAST_MODE_PROVIDER_IDS = new Set([
  "anthropic",
  "minimax",
  "minimax-portal",
  "openai",
  "openrouter",
  "rhcg",
  "xai",
]);`;

const hasPatchedControlUiFastModeProviderSet =
  source.includes(patchedMinifiedFastModeProviderSet) ||
  source.includes(patchedSourceFastModeProviderSet);

if (!hasPatchedControlUiFastModeProviderSet) {
  if (source.includes(minifiedFastModeProviderSet)) {
    source = replaceOnce(
      source,
      minifiedFastModeProviderSet,
      patchedMinifiedFastModeProviderSet,
      "Control UI RHCG fast mode provider allowlist patch",
    );
  } else if (source.includes(sourceFastModeProviderSet)) {
    source = replaceOnce(
      source,
      sourceFastModeProviderSet,
      patchedSourceFastModeProviderSet,
      "Control UI RHCG fast mode provider allowlist source patch",
    );
  } else {
    fail("Control UI chat speed selector chunk did not contain the expected fast mode provider allowlist");
  }
}

if (
  !source.includes(patchedMinifiedFastModeProviderSet) &&
  !source.includes(patchedSourceFastModeProviderSet)
) {
  fail("Control UI chat speed selector chunk did not receive RHCG fast mode provider allowlist patch");
}
writeText(controlUiIndexFile, source);

const controlUiServiceWorkerFile = path.join(distDir, "control-ui", "sw.js");
if (!fs.existsSync(controlUiServiceWorkerFile)) {
  fail(`OpenClaw Control UI service worker missing: ${controlUiServiceWorkerFile}`);
}
source = readText(controlUiServiceWorkerFile);
const controlUiCacheVersionPatchSuffix = "-rhcg-fastmode";
const controlUiEmbeddedCacheVersionMatch = source.match(
  /const EMBEDDED_CACHE_VERSION = "([^"]+)";/,
);
if (!controlUiEmbeddedCacheVersionMatch) {
  fail("Control UI service worker did not contain the expected embedded cache version marker");
}
const currentControlUiCacheVersion = controlUiEmbeddedCacheVersionMatch[1];
const patchedControlUiCacheVersion = currentControlUiCacheVersion.endsWith(
  controlUiCacheVersionPatchSuffix,
)
  ? currentControlUiCacheVersion
  : `${currentControlUiCacheVersion}${controlUiCacheVersionPatchSuffix}`;
if (patchedControlUiCacheVersion !== currentControlUiCacheVersion) {
  source = replaceOnce(
    source,
    `const EMBEDDED_CACHE_VERSION = "${currentControlUiCacheVersion}";`,
    `const EMBEDDED_CACHE_VERSION = "${patchedControlUiCacheVersion}";`,
    "Control UI RHCG fast mode service worker cache bust patch",
  );
}
if (!source.includes(`const EMBEDDED_CACHE_VERSION = "${patchedControlUiCacheVersion}";`)) {
  fail("Control UI service worker did not receive RHCG fast mode cache bust patch");
}
writeText(controlUiServiceWorkerFile, source);

const sessionTranscriptRepairFile = findSingleDistFile(
  distDir,
  /^session-transcript-repair-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes('const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult"') &&
    candidate.includes("function makeMissingToolResult"),
  "session transcript repair chunk",
);
source = readText(sessionTranscriptRepairFile);

if (!source.includes("function readFiniteTimestamp(value)")) {
  source = replaceOnce(
    source,
    `const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";
function makeMissingToolResult(params) {`,
    `const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";
function readFiniteTimestamp(value) {
\treturn typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function makeMissingToolResult(params) {`,
    "synthetic missing tool-result finite timestamp helper insertion",
  );
}

if (source.includes(",\n\t\ttimestamp: Date.now()")) {
  source = replaceOnce(
    source,
    `,\n\t\ttimestamp: Date.now()`,
    `,\n\t\ttimestamp: readFiniteTimestamp(params.sourceTimestamp) ?? 0`,
    "synthetic missing tool-result deterministic timestamp replacement",
  );
} else if (!source.includes("timestamp: readFiniteTimestamp(params.sourceTimestamp) ?? 0")) {
  source = replaceOnce(
    source,
    `\t\tdetails: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true },
\t\tisError: true
\t};`,
    `\t\tdetails: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true },
\t\tisError: true,
\t\ttimestamp: readFiniteTimestamp(params.sourceTimestamp) ?? 0
\t};`,
    "synthetic missing tool-result deterministic timestamp insertion",
  );
}

if (!source.includes("sourceTimestamp: readFiniteTimestamp(msg.timestamp)")) {
  source = replaceOnce(
    source,
    `\t\t\t\t\tconst missing = makeMissingToolResult({
\t\t\t\t\t\ttoolCallId: call.id,
\t\t\t\t\t\ttoolName: call.name,
\t\t\t\t\t\ttext: options?.missingToolResultText
\t\t\t\t\t});`,
    `\t\t\t\t\tconst missing = makeMissingToolResult({
\t\t\t\t\t\ttoolCallId: call.id,
\t\t\t\t\t\ttoolName: call.name,
\t\t\t\t\t\ttext: options?.missingToolResultText,
\t\t\t\t\t\tsourceTimestamp: readFiniteTimestamp(msg.timestamp)
\t\t\t\t\t});`,
    "synthetic missing tool-result transcript repair source timestamp propagation",
  );
}

if (source.includes("timestamp: Date.now()") && source.includes("function makeMissingToolResult")) {
  fail("session transcript repair chunk still contains Date.now() in synthetic missing tool result patch area");
}
if (!source.includes("timestamp: readFiniteTimestamp(params.sourceTimestamp) ?? 0")) {
  fail("session transcript repair chunk did not receive deterministic synthetic timestamp patch");
}
if (!source.includes("sourceTimestamp: readFiniteTimestamp(msg.timestamp)")) {
  fail("session transcript repair chunk did not propagate source timestamps for synthetic results");
}
writeText(sessionTranscriptRepairFile, source);

const sessionFileRepairFile = findSingleDistFile(
  distDir,
  /^[A-Za-z0-9_.-]+\.js$/,
  (candidate) =>
    candidate.includes("function makeSyntheticToolResultEntry") &&
    candidate.includes("function insertMissingCodeModeToolResults"),
  "session file repair synthetic tool-result chunk",
);
source = readText(sessionFileRepairFile);

if (!source.includes("function readFiniteTimestamp(value)")) {
  source = replaceOnce(
    source,
    `function makeSyntheticToolResultEntry(params) {`,
    `function readFiniteTimestamp(value) {
\treturn typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function makeSyntheticToolResultEntry(params) {`,
    "session file repair finite timestamp helper insertion",
  );
}

if (!source.includes("const parentEntryTimestamp =")) {
  source = replaceOnce(
    source,
    `function makeSyntheticToolResultEntry(params) {
\tconst message = makeMissingToolResult({
\t\ttoolCallId: params.toolCallId,
\t\ttoolName: params.toolName,
\t\ttext: "aborted"
\t});`,
    `function makeSyntheticToolResultEntry(params) {
\tconst parentEntryTimestamp = typeof params.parent.timestamp === "string" ? Date.parse(params.parent.timestamp) : void 0;
\tconst parentMessageTimestamp = readFiniteTimestamp(params.parent.message?.timestamp) ?? readFiniteTimestamp(parentEntryTimestamp);
\tconst message = makeMissingToolResult({
\t\ttoolCallId: params.toolCallId,
\t\ttoolName: params.toolName,
\t\ttext: "aborted",
\t\tsourceTimestamp: parentMessageTimestamp
\t});`,
    "session file repair synthetic result source timestamp propagation",
  );
}

if (!source.includes("sourceTimestamp: parentMessageTimestamp")) {
  fail("session file repair chunk did not propagate synthetic result source timestamp");
}
if (!source.includes("readFiniteTimestamp(parentEntryTimestamp)")) {
  fail("session file repair chunk did not use parent entry timestamp fallback");
}
writeText(sessionFileRepairFile, source);

const sessionToolResultGuardFile = findSingleDistFile(
  distDir,
  /^[A-Za-z0-9_.-]+\.js$/,
  (candidate) =>
    candidate.includes("function createPendingToolCallState") &&
    candidate.includes("function installSessionToolResultGuard"),
  "session tool-result guard chunk",
);
source = readText(sessionToolResultGuardFile);

if (!source.includes("function readFiniteTimestamp(value)")) {
  source = replaceOnce(
    source,
    `function createPendingToolCallState() {`,
    `function readFiniteTimestamp(value) {
\treturn typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function createPendingToolCallState() {`,
    "session tool-result guard finite timestamp helper insertion",
  );
}

if (!source.includes("getToolName: (id) => pending.get(id)?.name")) {
  source = replaceOnce(
    source,
    `\t\tgetToolName: (id) => pending.get(id),`,
    `\t\tgetToolName: (id) => pending.get(id)?.name,`,
    "pending tool-call state tool name accessor patch",
  );
}

if (!source.includes("timestamp: call.timestamp")) {
  source = replaceOnce(
    source,
    `\t\ttrackToolCalls: (calls) => {
\t\t\tfor (const call of calls) pending.set(call.id, call.name);
\t\t},`,
    `\t\ttrackToolCalls: (calls) => {
\t\t\tfor (const call of calls) pending.set(call.id, {
\t\t\t\t...(call.name !== void 0 ? { name: call.name } : {}),
\t\t\t\t...(call.timestamp !== void 0 ? { timestamp: call.timestamp } : {})
\t\t\t});
\t\t},`,
    "pending tool-call state timestamp tracking patch",
  );
}

if (!source.includes("for (const [id, entry] of pendingState.entries())")) {
  source = replaceOnce(
    source,
    `\t\tif (allowSyntheticToolResults) for (const [id, name] of pendingState.entries()) {
\t\t\tconst synthetic = makeMissingToolResult({
\t\t\t\ttoolCallId: id,
\t\t\t\ttoolName: name,
\t\t\t\ttext: missingToolResultText
\t\t\t});
\t\t\tconst persistedSynthetic = persistMessage(synthetic);
\t\t\tconst transformed = persistToolResult(persistedSynthetic, {
\t\t\t\ttoolCallId: id,
\t\t\t\ttoolName: name,
\t\t\t\tisSynthetic: true
\t\t\t});`,
    `\t\tif (allowSyntheticToolResults) for (const [id, entry] of pendingState.entries()) {
\t\t\tconst synthetic = makeMissingToolResult({
\t\t\t\ttoolCallId: id,
\t\t\t\ttoolName: entry.name,
\t\t\t\ttext: missingToolResultText,
\t\t\t\tsourceTimestamp: entry.timestamp
\t\t\t});
\t\t\tconst persistedSynthetic = persistMessage(synthetic);
\t\t\tconst transformed = persistToolResult(persistedSynthetic, {
\t\t\t\ttoolCallId: id,
\t\t\t\ttoolName: entry.name,
\t\t\t\tisSynthetic: true
\t\t\t});`,
    "pending synthetic tool-result source timestamp propagation patch",
  );
}

if (!source.includes("const assistantTimestamp = readFiniteTimestamp(finalMessage.timestamp);")) {
  source = replaceOnce(
    source,
    `\t\tif (toolCalls.length > 0) pendingState.trackToolCalls(toolCalls);`,
    `\t\tif (toolCalls.length > 0) {
\t\t\tconst assistantTimestamp = readFiniteTimestamp(finalMessage.timestamp);
\t\t\tpendingState.trackToolCalls(toolCalls.map((call) => {
\t\t\t\tif (assistantTimestamp === void 0) return call;
\t\t\t\treturn {
\t\t\t\t\tid: call.id,
\t\t\t\t\tname: call.name,
\t\t\t\t\ttimestamp: assistantTimestamp
\t\t\t\t};
\t\t\t}));
\t\t}`,
    "pending tool-call assistant timestamp capture patch",
  );
}

if (!source.includes("getToolName: (id) => pending.get(id)?.name")) {
  fail("session tool-result guard chunk did not update pending tool-call state shape");
}
if (!source.includes("sourceTimestamp: entry.timestamp")) {
  fail("session tool-result guard chunk did not propagate pending synthetic timestamps");
}
if (!source.includes("const assistantTimestamp = readFiniteTimestamp(finalMessage.timestamp);")) {
  fail("session tool-result guard chunk did not capture assistant timestamps for pending tool calls");
}
writeText(sessionToolResultGuardFile, source);
