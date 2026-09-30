import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const patcher = fileURLToPath(new URL("./patch-missing-tool-timestamp-npm-dist.mjs", import.meta.url));
const files = {
  "tool-result-pairing-fixture.mjs": `function makeMissingToolResult(params) {\n\treturn {\n\t\trole: "toolResult",\n\t\tisError: true,\n\t\ttimestamp: Date.now()\n\t};\n}\nfunction isSyntheticMissingToolResult(message) { return message.isError; }\nexport { makeMissingToolResult };\n`,
  "session-transcript-repair-fixture.mjs": `import { makeMissingToolResult } from "./tool-result-pairing-fixture.mjs";\nfunction repairToolUseResultPairing(frame, options) {\n  const occurrence = { id: "call", name: "read" };\n\t\t\t\tconst missing = makeMissingToolResult({\n\t\t\t\t\ttoolCallId: occurrence.id,\n\t\t\t\t\ttoolName: occurrence.name,\n\t\t\t\t\ttext: options?.missingToolResultText\n\t\t\t\t});\n  return missing;\n}\nexport { repairToolUseResultPairing };\n`,
};

async function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-tool-timestamp-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dist, name), source);
    }
    await run(root, dist);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function patch(root) {
  return spawnSync(process.execPath, [patcher], {
    env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

test("synthetic transcript repair inherits finite assistant timestamps", async () => {
  await withFixture(async (root, dist) => {
    const result = patch(root);
    assert.equal(result.status, 0, result.stderr);
    const { repairToolUseResultPairing } = await import(pathToFileURL(path.join(dist, "session-transcript-repair-fixture.mjs")).href);
    const { makeMissingToolResult } = await import(pathToFileURL(path.join(dist, "tool-result-pairing-fixture.mjs")).href);
    const beforeLive = Date.now();
    const live = makeMissingToolResult({ toolCallId: "live" });
    assert.ok(live.timestamp >= beforeLive && live.timestamp <= Date.now());
    assert.equal(repairToolUseResultPairing({ assistant: { timestamp: 123 } }, {}).timestamp, 123);
    assert.equal(repairToolUseResultPairing({ assistant: { timestamp: 123 } }, {}).timestamp, 123);
    assert.equal(repairToolUseResultPairing({ assistant: { timestamp: NaN } }, {}).timestamp, 0);
    assert.equal(repairToolUseResultPairing({ assistant: {} }, {}).timestamp, 0);
  });
});

test("contract failure leaves original chunks untouched", () => {
  withFixture((root, dist) => {
    const repair = path.join(dist, "session-transcript-repair-fixture.mjs");
    const original = fs.readFileSync(repair, "utf8");
    fs.writeFileSync(repair, original.replace("text: options?.missingToolResultText", "text: null"));
    const pairing = path.join(dist, "tool-result-pairing-fixture.mjs");
    const originalPairing = fs.readFileSync(pairing, "utf8");
    assert.notEqual(patch(root).status, 0);
    assert.equal(fs.readFileSync(pairing, "utf8"), originalPairing);
  });
});
