#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dist = path.join(root, "dist");
const owner = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs") &&
  fs.readFileSync(path.join(dist, name), "utf8").includes("function applyPostPluginStreamWrappers(ctx)"));
if (owner.length !== 1) throw new Error(`RHCG stream wrapper: expected one owner, found ${owner.length}`);
const wrapperPath = path.join(dist, owner[0]);
const assets = path.join(dist, "control-ui", "assets");
const allowlist = "new Set([`anthropic`,`minimax`,`minimax-portal`,`openai`,`xai`])";
const patchedAllowlist = "new Set([`anthropic`,`minimax`,`minimax-portal`,`openai`,`rhcg`,`xai`])";
const uiOwners = fs.readdirSync(assets).filter((name) => name.endsWith(".js") &&
  fs.readFileSync(path.join(assets, name), "utf8").includes(allowlist));
const patchedUiOwners = fs.readdirSync(assets).filter((name) => name.endsWith(".js") &&
  fs.readFileSync(path.join(assets, name), "utf8").includes(patchedAllowlist));
if (uiOwners.length + patchedUiOwners.length !== 1) {
  throw new Error("RHCG Control UI allowlist: expected one owner");
}
const uiPath = path.join(assets, (uiOwners[0] ?? patchedUiOwners[0]));
const swPath = path.join(dist, "control-ui", "sw.js");
const sw = fs.readFileSync(swPath, "utf8");
const version = sw.match(/const EMBEDDED_CACHE_VERSION = "([^"]+)";/);
if (!version) throw new Error("RHCG Control UI service worker version is missing");
function replaceOnce(source, before, after, label) {
  if (source.includes(after) && source.split(after).length === 2) return source;
  if (source.split(before).length !== 2) throw new Error(`${label}: unexpected dist contract`);
  return source.replace(before, after);
}
const wrapper = fs.readFileSync(wrapperPath, "utf8");
const marker = "function createRhcgRequestWrapper(streamFn, thinkingLevel, params) {";
const functionBody = `function createRhcgRequestWrapper(streamFn, thinkingLevel, params) {
	return (model, context, options) => {
		if (model.provider !== "rhcg" || model.api !== "openai-responses" && model.api !== "openai-completions") return streamFn(model, context, options);
		const explicitTier = resolveAliasedParamValueFromKeys([params], ["serviceTier", "service_tier"]);
		const normalizedTier = typeof explicitTier === "string" ? explicitTier.trim().toLowerCase() : "";
		const rawFast = resolveAliasedParamValueFromKeys([params], ["fastMode", "fast_mode"]);
		const fast = rawFast === true || typeof rawFast === "string" && ["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(rawFast.trim().toLowerCase());
		const tier = ["auto", "default", "flex", "priority"].includes(normalizedTier) ? normalizedTier : fast ? "priority" : void 0;
		const effort = thinkingLevel === "max" ? "max" : thinkingLevel;
		const compat = model.compat;
		const supportsEffort = model.reasoning === true && compat?.supportsReasoningEffort !== false && Array.isArray(compat?.supportedReasoningEfforts) && compat.supportedReasoningEfforts.includes(effort ?? "");
		return streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
			if (tier !== void 0 && payload.service_tier === void 0) payload.service_tier = tier;
			if (thinkingLevel === "off") {
				if (model.api === "openai-responses") delete payload.reasoning;
				else delete payload.reasoning_effort;
			} else if (supportsEffort && effort) {
				if (model.api === "openai-responses") {
					const existing = payload.reasoning;
					payload.reasoning = { ...existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}, effort };
				} else payload.reasoning_effort = effort;
			}
		});
	};
}
`;
let nextWrapper = wrapper;
if (!nextWrapper.includes(marker)) {
  nextWrapper = replaceOnce(nextWrapper,
    "function applyPostPluginStreamWrappers(ctx) {",
    functionBody + "function applyPostPluginStreamWrappers(ctx) {",
    "RHCG request wrapper");
}
nextWrapper = replaceOnce(nextWrapper,
  "\tctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(ctx.agent.streamFn);\n\tif (!ctx.providerWrapperHandled) {",
  "\tctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(ctx.agent.streamFn);\n\tif (ctx.provider === \"rhcg\" && ctx.agent.streamFn) ctx.agent.streamFn = createRhcgRequestWrapper(ctx.agent.streamFn, ctx.thinkingLevel, streamParams);\n\tif (!ctx.providerWrapperHandled) {",
  "RHCG wrapper registration");
const nextUi = replaceOnce(fs.readFileSync(uiPath, "utf8"), allowlist, patchedAllowlist, "RHCG UI allowlist");
const nextSw = version[1].endsWith("-rhcg-openai-compat") ? sw : replaceOnce(sw,
  `const EMBEDDED_CACHE_VERSION = "${version[1]}";`,
  `const EMBEDDED_CACHE_VERSION = "${version[1]}-rhcg-openai-compat";`,
  "RHCG UI cache bust");
// Verify all inputs before committing any output.
fs.writeFileSync(wrapperPath, nextWrapper);
fs.writeFileSync(uiPath, nextUi);
fs.writeFileSync(swPath, nextSw);
