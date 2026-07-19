#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  fail("OPENCLAW_PACKAGE_ROOT is required");
}

const distDir = path.join(root, "dist");
if (!fs.existsSync(distDir)) {
  fail(`OpenClaw dist directory missing: ${distDir}`);
}

const oldFormula =
  "const contextShareChars = Math.floor(contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);";
const patchedFormula =
  "const contextShareChars = Math.floor(contextWindowTokens * 2 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE);";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(distDir, name))
  .filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes("function resolveLiveToolResultAggregateMaxChars") &&
      (source.includes(oldFormula) || source.includes(patchedFormula))
    );
  });

if (candidates.length !== 1) {
  fail(`expected exactly one aggregate tool-result budget chunk, found ${candidates.length}`);
}

const target = candidates[0];
let source = fs.readFileSync(target, "utf8");
if (!source.includes(patchedFormula)) {
  const matches = source.split(oldFormula).length - 1;
  if (matches !== 1) {
    fail(`aggregate tool-result budget formula: expected one match, found ${matches}`);
  }
  source = source.replace(oldFormula, patchedFormula);
}

if (!source.includes(patchedFormula) || source.includes(oldFormula)) {
  fail("aggregate tool-result budget formula was not patched completely");
}
fs.writeFileSync(target, source);
