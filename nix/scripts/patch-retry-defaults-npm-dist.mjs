#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
function replaceInOwner(marker, before, after) {
  const owners = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))
    .map((name) => path.join(dist, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(marker));
  if (owners.length !== 1) {
    throw new Error(`${marker}: expected one owner, found ${owners.length}`);
  }
  const file = owners[0];
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(after) && source.split(after).length === 2) {
    return;
  }
  if (source.split(before).length !== 2) {
    throw new Error(`${before}: source changed or repeated`);
  }
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
}
replaceInOwner("getProviderRetrySettings() {",
  "maxRetries: this.settings.retry?.provider?.maxRetries,",
  "maxRetries: this.settings.retry?.provider?.maxRetries ?? 4,");
replaceInOwner("function resolveLlmIdleTimeoutMs(",
  "const DEFAULT_LLM_IDLE_TIMEOUT_MS = 12e4;",
  "const DEFAULT_LLM_IDLE_TIMEOUT_MS = 3e5;");
