#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("OPENCLAW_PACKAGE_ROOT is required");
}
const dist = path.join(root, "dist");
const matches = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(dist, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes("const SessionsSendToolSchema = Type.Object({"));
if (matches.length !== 1) {
  throw new Error(`expected one sessions_send schema chunk, found ${matches.length}`);
}
const file = matches[0];
let source = fs.readFileSync(file, "utf8");
const begin = source.indexOf("const SessionsSendToolSchema = Type.Object({");
const end = source.indexOf("\n\tmessage: Type.String()", begin);
if (begin < 0 || end < begin) {
  throw new Error("sessions_send schema boundaries changed");
}
let schema = source.slice(begin, end);
for (const field of ["label", "agentId"]) {
  const original = new RegExp(`(${field}: Type\\.Optional\\(Type\\.String\\(\\{\\s*minLength: )1(,\\s*maxLength: )`);
  if (original.test(schema)) {
    schema = schema.replace(original, (_match, prefix, suffix) => `${prefix}0${suffix}`);
  } else if (!new RegExp(`${field}: Type\\.Optional\\(Type\\.String\\(\\{\\s*minLength: 0,`).test(schema)) {
    throw new Error(`${field} selector schema changed`);
  }
}
source = source.slice(0, begin) + schema + source.slice(end);
fs.writeFileSync(file, source);
