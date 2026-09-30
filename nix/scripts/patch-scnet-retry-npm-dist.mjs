#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
const files = fs.readdirSync(dist)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(dist, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes("function shouldBypassLongSdkRetry(response)"));
if (files.length !== 1) {
  throw new Error(`expected one provider transport retry chunk, found ${files.length}`);
}
const file = files[0];
let source = fs.readFileSync(file, "utf8");
const original = "if (shouldBypassLongSdkRetry(response)) {";
const patched = "if (!allowScnetHeaderless429 && shouldBypassLongSdkRetry(response)) {";
if (!source.includes(patched)) {
  if (source.split(original).length !== 2) {
    throw new Error("provider retry decision changed");
  }
  source = source.replace(original,
    `const allowScnetHeaderless429 = model.provider === "scnet" && response.status === 429 && !response.headers.has("retry-after") && !response.headers.has("retry-after-ms");\n\t\t${patched}`);
}
if (source.split(patched).length !== 2) {
  throw new Error("SCNet 429 exception missing or duplicated");
}
fs.writeFileSync(file, source);
