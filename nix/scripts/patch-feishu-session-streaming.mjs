#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: patch-feishu-session-streaming.mjs <plugin-root>");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
if (packageJson.name !== "@openclaw/feishu" || manifest.id !== "feishu") {
  throw new Error("Feishu runtime plugin identity mismatch");
}
const dir = path.join(root, "dist", ".setup");
const owners = fs.readdirSync(dir).filter((name) => /^monitor\.account-[-\w]+\.mjs$/.test(name) &&
  fs.readFileSync(path.join(dir, name), "utf8").includes("const flushStreamingCardUpdate = (combined) =>"));
if (owners.length !== 1) throw new Error(`Feishu streaming dispatcher: expected one owner, found ${owners.length}`);
const file = path.join(dir, owners[0]);
let source = fs.readFileSync(file, "utf8");
function replaceOnce(before, after, label) {
  if (source.includes(after) && source.split(after).length === 2) return;
  if (source.split(before).length !== 2) throw new Error(`${label}: unexpected plugin bundle contract`);
  source = source.replace(before, after);
}
replaceOnce("\tlet partialUpdateQueue = Promise.resolve();", "\tconst pendingStreamingUpdates = new Set();", "dispatcher queue owner");
replaceOnce(
  "\t\tpartialUpdateQueue = partialUpdateQueue.then(async () => {\n\t\t\tif (startPromise) await startPromise;\n\t\t\tif (generation !== void 0 && session?.isActive()) await session.update(combined);\n\t\t});",
  "\t\tif (generation === void 0 || !session) return;\n\t\tconst update = (async () => {\n\t\t\tif (startPromise) await startPromise;\n\t\t\tif (session.isActive()) await session.update(combined);\n\t\t})().catch((error) => { params.runtime.error?.(`feishu[${account.accountId}]: streaming update failed: ${String(error)}`); });\n\t\tpendingStreamingUpdates.add(update);\n\t\tvoid update.then(() => pendingStreamingUpdates.delete(update));",
  "session-owned update");
replaceOnce("\t\tpartialUpdateQueue = Promise.resolve();\n", "\t\t// Session-owned updates settle at the close barrier.\n", "streaming reset");
replaceOnce("\t\tconst updateQueueToClose = partialUpdateQueue;", "\t\tconst updatesToClose = [...pendingStreamingUpdates];", "close barrier snapshot");
replaceOnce("\t\t\tawait updateQueueToClose;", "\t\t\tawait Promise.all(updatesToClose);", "close barrier wait");
if (source.includes("partialUpdateQueue") || source.includes("updateQueueToClose")) {
  throw new Error("Feishu dispatcher still contains an outer per-preview queue");
}
fs.writeFileSync(file, source);
