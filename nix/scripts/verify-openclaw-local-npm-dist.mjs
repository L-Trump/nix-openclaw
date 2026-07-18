#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function findSingleDistFile(distDir, pattern, predicate, description) {
  const files = fs
    .readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => predicate(fs.readFileSync(file, "utf8")));

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

const thinkingRuntimeFile = findSingleDistFile(
  distDir,
  /^thinking-runtime-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("function resolveCandidateThinkingLevel") &&
    candidate.includes("const catalog = params.catalog ?? buildConfiguredModelCatalog"),
  "patched candidate thinking-level runtime chunk",
);
const statusTextFile = findSingleDistFile(
  distDir,
  /^status-text-[A-Za-z0-9_-]+\.js$/,
  (candidate) =>
    candidate.includes("const effectiveThinkLevel = resolveSupportedThinkingLevel") &&
    candidate.includes("catalog: buildConfiguredModelCatalog({ cfg })"),
  "patched status thinking-level projection chunk",
);

const thinkingRuntime = await import(pathToFileURL(thinkingRuntimeFile).href);
const resolveCandidateThinkingLevel = Object.values(thinkingRuntime).find(
  (candidate) =>
    typeof candidate === "function" && candidate.name === "resolveCandidateThinkingLevel",
);
if (!resolveCandidateThinkingLevel) {
  fail("patched candidate thinking-level resolver export was not found");
}

const cfg = {
  models: {
    providers: {
      rhcg: {
        api: "openai-completions",
        models: [
          {
            id: "gpt-5.6-sol",
            reasoning: true,
            compat: {
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
              thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            },
          },
        ],
      },
    },
  },
};

for (const level of ["xhigh", "max"]) {
  const actual = resolveCandidateThinkingLevel({
    cfg,
    provider: "rhcg",
    modelId: "gpt-5.6-sol",
    level,
    agentRuntime: "openclaw",
  });
  if (actual !== level) {
    fail(`configured RHCG thinking level ${level} was downgraded to ${actual}`);
  }
}

const statusSource = fs.readFileSync(statusTextFile, "utf8");
if (!statusSource.includes("catalog: buildConfiguredModelCatalog({ cfg })")) {
  fail("status thinking-level projection does not use the configured model catalog");
}

console.log("openclaw local npm dist verification: RHCG xhigh/max preserved");
