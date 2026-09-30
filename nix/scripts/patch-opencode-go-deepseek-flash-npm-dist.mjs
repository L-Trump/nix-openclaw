#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dist = path.join(root, "dist");
const marker = 'shouldPatchModel: (model) => model.provider === "opencode-go" && model.id === "deepseek-v4-pro"';
const patched = 'shouldPatchModel: (model) => model.provider === "opencode-go" && (model.id === "deepseek-v4-pro" || model.id === "deepseek-flash")';
const candidates = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs") &&
  fs.readFileSync(path.join(dist, name), "utf8").includes("function createOpencodeGoDeepSeekWrapper("));
if (candidates.length !== 1) throw new Error(`OpenCode Go stream: expected one bundle, found ${candidates.length}`);
const file = path.join(dist, candidates[0]);
const source = fs.readFileSync(file, "utf8");
if (source.includes(patched) && source.split(patched).length === 2) process.exit(0);
if (source.split(marker).length !== 2) throw new Error("OpenCode Go DeepSeek V4 wire contract changed");
fs.writeFileSync(file, source.replace(marker, patched));
