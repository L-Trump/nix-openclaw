#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dist = path.join(root, "dist");
const owners = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs") &&
  fs.readFileSync(path.join(dist, name), "utf8").includes("function installSessionToolResultGuard(sessionManager, opts)"));
if (owners.length !== 1) throw new Error(`pending tool-result guard: expected one owner, found ${owners.length}`);
const file = path.join(dist, owners[0]);
let source = fs.readFileSync(file, "utf8");
function replaceOnce(before, after, label) {
  if (source.includes(after) && source.split(after).length === 2) return;
  if (source.split(before).length !== 2) throw new Error(`${label}: unexpected dist contract`);
  source = source.replace(before, after);
}
replaceOnce(
  "for (const call of extractPendingAssistantToolCalls(persistedMessage)) pending.set(call.id, call.name);",
  "for (const call of extractPendingAssistantToolCalls(persistedMessage)) pending.set(call.id, { name: call.name, timestamp: Number.isFinite(persistedMessage.timestamp) ? persistedMessage.timestamp : void 0 });",
  "pending assistant timestamp");
replaceOnce(
  "if (allowSyntheticToolResults) for (const [id, name] of pending.entries()) {\n\t\t\tconst synthetic = makeMissingToolResult({\n\t\t\t\ttoolCallId: id,\n\t\t\t\ttoolName: name,\n\t\t\t\ttext: missingToolResultText",
  "if (allowSyntheticToolResults) for (const [id, entry] of pending.entries()) {\n\t\t\tconst synthetic = makeMissingToolResult({\n\t\t\t\ttoolCallId: id,\n\t\t\t\ttoolName: entry.name,\n\t\t\t\ttext: missingToolResultText,\n\t\t\t\tsourceTimestamp: entry.timestamp",
  "pending synthetic timestamp");
replaceOnce("\t\t\t\ttoolName: name,\n\t\t\t\tisSynthetic: true", "\t\t\t\ttoolName: entry.name,\n\t\t\t\tisSynthetic: true", "synthetic metadata name");
replaceOnce("const toolName = id ? pending.get(id) : void 0;", "const toolName = id ? pending.get(id)?.name : void 0;", "tool name accessor");
fs.writeFileSync(file, source);
