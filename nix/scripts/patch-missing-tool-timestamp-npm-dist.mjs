#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) throw new Error("OPENCLAW_PACKAGE_ROOT is required");
const dir = path.join(root, "dist");
const modules = fs.readdirSync(dir).filter((name) => /^[-\w]+\.mjs$/.test(name));
const select = (marker, label) => {
  const matches = modules.filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes(marker));
  if (matches.length !== 1) throw new Error(`${label}: expected one owner, found ${matches.length}`);
  return matches[0];
};
const replaceOnce = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error(`${label}: unexpected dist contract`);
  return source.replace(before, after);
};
const pairingName = select("function makeMissingToolResult(params) {\n\treturn {", "tool pairing");
const repairName = select("function repairToolUseResultPairing(", "transcript repair");
if (pairingName === repairName) throw new Error("tool pairing and transcript repair share an unexpected owner");
const pairing = fs.readFileSync(path.join(dir, pairingName), "utf8");
const repair = fs.readFileSync(path.join(dir, repairName), "utf8");
const nextPairing = replaceOnce(
  pairing,
  "\t\ttimestamp: Date.now()\n\t};\n}\nfunction isSyntheticMissingToolResult",
  "\t\ttimestamp: Number.isFinite(params.sourceTimestamp) ? params.sourceTimestamp : Date.now()\n\t};\n}\nfunction isSyntheticMissingToolResult",
  "synthetic pairing timestamp",
);
const missingCall = "\t\t\t\tconst missing = makeMissingToolResult({\n\t\t\t\t\ttoolCallId: occurrence.id,\n\t\t\t\t\ttoolName: occurrence.name,\n\t\t\t\t\ttext: options?.missingToolResultText\n\t\t\t\t});";
const nextRepair = replaceOnce(
  repair,
  missingCall,
  missingCall.replace("text: options?.missingToolResultText", "text: options?.missingToolResultText,\n\t\t\t\t\tsourceTimestamp: Number.isFinite(frame.assistant.timestamp) ? frame.assistant.timestamp : 0"),
  "transcript repair timestamp source",
);
// Both transforms are verified before either output is written.
fs.writeFileSync(path.join(dir, pairingName), nextPairing);
fs.writeFileSync(path.join(dir, repairName), nextRepair);
