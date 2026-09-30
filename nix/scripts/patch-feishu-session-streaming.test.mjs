import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const sourcePlugin = process.env.OPENCLAW_FEISHU_PLUGIN;
const patcher = path.join(import.meta.dirname, "patch-feishu-session-streaming.mjs");
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("Feishu session owns coalescing while close waits for all started updates", { skip: !sourcePlugin }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-streaming-"));
  try {
    const sourceDir = path.join(sourcePlugin, "dist", ".setup");
    const owners = fs.readdirSync(sourceDir).filter((name) => /^monitor\.account-[-\w]+\.mjs$/.test(name) &&
      fs.readFileSync(path.join(sourceDir, name), "utf8").includes("const flushStreamingCardUpdate = (combined) =>"));
    assert.equal(owners.length, 1);
    const dir = path.join(root, "dist", ".setup");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["package.json", "openclaw.plugin.json"]) {
      fs.copyFileSync(path.join(sourcePlugin, name), path.join(root, name));
    }
    const file = path.join(dir, owners[0]);
    fs.copyFileSync(path.join(sourceDir, owners[0]), file);
    fs.chmodSync(file, 0o644);
    for (let i = 0; i < 2; i++) {
      const patched = spawnSync(process.execPath, [patcher, root], { encoding: "utf8" });
      assert.equal(patched.status, 0, patched.stderr);
    }
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /partialUpdateQueue/);
    assert.match(source, /await Promise\.all\(updatesToClose\)/);
    const start = source.indexOf("const flushStreamingCardUpdate = (combined) => {");
    const end = source.indexOf("const queueStreamingUpdate =", start);
    assert.ok(start >= 0 && end > start);
    const first = deferred();
    const calls = [];
    const sandbox = {
      streaming: { isActive: () => true, update: (value) => { calls.push(value); return calls.length === 1 ? first.promise : Promise.resolve(); } },
      activeStreamingGeneration: 1,
      streamingStartPromise: Promise.resolve(),
      pendingStreamingUpdates: new Set(),
      params: { runtime: { error: (error) => { throw new Error(error); } } },
      account: { accountId: "test" },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end).replace("const flushStreamingCardUpdate", "globalThis.flushStreamingCardUpdate"), sandbox);
    sandbox.flushStreamingCardUpdate("partial-1");
    sandbox.flushStreamingCardUpdate("partial-2");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["partial-1", "partial-2"], "second preview must reach the session before first slow write resolves");
    const closed = [];
    sandbox.streaming.closeWithResult = async (text) => {
      closed.push(text);
      return { visibleReplySent: true, content: text };
    };
    Object.assign(sandbox, {
      streamText: "final", reasoningText: "", statusLine: "",
      noVisibleFeishuReplyDelivery: { visibleReplySent: false },
      createFeishuReplyDeliveryResult: ({ content, visibleReplySent }) => ({ content, visibleReplySent }),
      buildCombinedStreamText: (_thinking, answer) => answer,
      resolveCardNote: () => undefined, responsePrefixContextProvider: () => undefined,
      agentId: "test", identity: {},
      markVisibleReplySent: () => {}, deliveredFinalTexts: new Set(),
      rememberClosedStreamingSettlement: () => {},
      FeishuStreamingFinalizationError: class extends Error {},
      resetStreamingState: () => {},
    });
    const closeStart = source.indexOf("const performStreamingClose = async (disposition) => {");
    const closeEnd = source.indexOf("const closeStreaming =", closeStart);
    assert.ok(closeStart >= 0 && closeEnd > closeStart);
    vm.runInContext(source.slice(closeStart, closeEnd).replace("const performStreamingClose", "globalThis.performStreamingClose"), sandbox);
    const close = sandbox.performStreamingClose("closed");
    sandbox.flushStreamingCardUpdate("late");
    assert.equal(sandbox.pendingStreamingUpdates.size, 1, "sealed generation cannot add work");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, [], "close waits for the slow accepted preview");
    first.resolve();
    const result = await close;
    assert.equal(result.result.visibleReplySent, true);
    assert.deepEqual(closed, ["final"]);
    assert.deepEqual(calls, ["partial-1", "partial-2"]);

    // A failed preview cannot poison the close barrier or delay later updates.
    const errors = [];
    sandbox.params.runtime.error = (error) => errors.push(error);
    sandbox.activeStreamingGeneration = 2;
    sandbox.streaming = {
      isActive: () => true,
      update: async (text) => {
        if (text === "failed-preview") throw new Error("preview write failed");
        calls.push(text);
      },
    };
    sandbox.flushStreamingCardUpdate("failed-preview");
    sandbox.flushStreamingCardUpdate("recovered-preview");
    await Promise.all([...sandbox.pendingStreamingUpdates]);
    assert.match(errors.join("\n"), /preview write failed/);
    assert.equal(calls.at(-1), "recovered-preview");

    // Pre-start partials stay owned by the original session, and close drains them
    // only after the card becomes active. A failed start skips both updates.
    const starting = deferred();
    const beforeStart = [];
    sandbox.streamingStartPromise = starting.promise;
    sandbox.streaming = {
      isActive: () => true,
      update: async (text) => { beforeStart.push(text); },
    };
    sandbox.activeStreamingGeneration = 3;
    sandbox.flushStreamingCardUpdate("pre-start-1");
    sandbox.flushStreamingCardUpdate("pre-start-2");
    const pendingStartClose = sandbox.performStreamingClose("closed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(beforeStart, []);
    starting.resolve();
    await pendingStartClose;
    assert.deepEqual(beforeStart, ["pre-start-1", "pre-start-2"]);

    const manifestPath = path.join(root, "openclaw.plugin.json");
    fs.chmodSync(manifestPath, 0o644);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: "other" }));
    const invalid = spawnSync(process.execPath, [patcher, root], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0, "unexpected plugin identity must fail closed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
