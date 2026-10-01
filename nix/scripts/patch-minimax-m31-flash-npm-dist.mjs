#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dist = path.join(root, "dist");
function uniqueOwner(marker) {
  const owners = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs") &&
    fs.readFileSync(path.join(dist, name), "utf8").includes(marker));
  if (owners.length !== 1) throw new Error(`MiniMax ${marker}: expected one bundle, found ${owners.length}`);
  return path.join(dist, owners[0]);
}
function patchOnce(file, original, updated) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(updated) && source.split(updated).length === 2) return;
  if (source.split(original).length !== 2) throw new Error(`MiniMax bundle contract changed: ${path.basename(file)}`);
  fs.writeFileSync(file, source.replace(original, updated));
}
const thinking = uniqueOwner("function resolveMinimaxThinkingProfile(");
patchOnce(thinking,
  'function resolveMinimaxThinkingProfile(modelId) {\n\tif (/^MiniMax-M3(\\b|[-.])/i.test(modelId))',
  'function resolveMinimaxThinkingProfile(modelId) {\n\tif (/^MiniMax-M3\\.1-Flash-Preview$/i.test(modelId)) return { levels: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })), defaultLevel: "max" };\n\tif (/^MiniMax-M3(\\b|[-.])/i.test(modelId))',
);
const proxy = uniqueOwner("function createMinimaxThinkingDisabledWrapper(");
patchOnce(proxy,
  '\t\tconst isM3 = isMinimaxM3Model(model);\n\t\treturn streamWithPayloadPatch(underlying, model, context, options, (payload) => {',
  '\t\tconst isM3 = isMinimaxM3Model(model);\n\t\tconst isM31Flash = /^MiniMax-M3\\.1-Flash-Preview$/i.test(model.id);\n\t\tconst requestedLevel = thinkingLevel ?? "max";\n\t\tif (isM31Flash && requestedLevel === "off") throw new Error("MiniMax-M3.1-Flash-Preview does not support thinking off");\n\t\tconst effort = requestedLevel === "adaptive" ? "max" : requestedLevel;\n\t\tif (isM31Flash && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`MiniMax-M3.1-Flash-Preview does not support thinking level ${effort}`);\n\t\treturn streamWithPayloadPatch(underlying, model, context, options, (payload) => {\n\t\t\tif (isM31Flash) {\n\t\t\t\tpayload.thinking = { type: "adaptive" };\n\t\t\t\tpayload.output_config = { ...asOptionalRecord(payload.output_config), effort };\n\t\t\t\tconst maxTokens = resolvePositiveMaxTokens(options?.maxTokens);\n\t\t\t\tif (maxTokens !== void 0) payload.max_tokens = maxTokens;\n\t\t\t\treturn;\n\t\t\t}',
);
