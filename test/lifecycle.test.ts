import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

test("parallel tools, steering, and queued follow-ups belong to one completed processing round", { timeout: 10000 }, async () => {
  const testWorkspace = await fixture();
  const modelStarted = gate();
  const releaseModel = gate();
  const toolsStarted = gate();
  const writes: string[] = [];
  const app = await load(testWorkspace, undefined, { extensionFactories: [pi => {
    pi.registerTool({
      name: "fixture_write", label: "Fixture write", description: "Write a deterministic test file.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, { path }) {
        writes.push(path);
        if (writes.length === 2) toolsStarted.open();
        await toolsStarted.promise;
        await writeFile(join(testWorkspace.cwd, path), "parallel tool output\n");
        return { content: [{ type: "text", text: "Written." }], details: {} };
      },
    });
  }] });
  try {
    let request = 0;
    const inputHistory: string[] = [];
    await useModel(app, async (_model, context) => {
      assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 0, "No intermediate checkpoint");
      inputHistory.push(JSON.stringify(context.messages.filter(message => message.role === "user")));
      if (request++ === 0) {
        modelStarted.open();
        await releaseModel.promise;
        return responseStream({ stopReason: "toolUse", content: [
          { type: "toolCall", id: "write-one", name: "fixture_write", arguments: { path: "one.txt" } },
          { type: "toolCall", id: "write-two", name: "fixture_write", arguments: { path: "two.txt" } },
        ] });
      }
      return responseStream({ content: [{ type: "text", text: "Finished response." }] });
    });
    const running = app.session.prompt("Start work.");
    await modelStarted.promise;
    assert.equal(await app.session.steer("Steering input."), "queued");
    assert.equal(await app.session.followUp("Queued follow-up."), "queued");
    releaseModel.open();
    await running;
    assert.equal(inputHistory.length, 3);
    assert.doesNotMatch(inputHistory[0], /Steering input|Queued follow-up/);
    assert.match(inputHistory[1], /Steering input/);
    assert.doesNotMatch(inputHistory[1], /Queued follow-up/);
    assert.match(inputHistory[2], /Queued follow-up/);
    const catalog = (await app.checkpoints()).details as any;
    assert.equal(catalog.checkpoints.length, 1);
    const total = (await app.diff({ scope: "session" })).details as any;
    assert.deepEqual(total.files.map((file: any) => file.path), ["one.txt", "two.txt"]);
    assert.equal(app.session.isIdle, true);
  } finally { releaseModel.open(); toolsStarted.open(); dispose(app.session); }
});

test("retry recovery and a before-settle continuation do not publish intermediate checkpoints", async () => {
  const testWorkspace = await fixture();
  let continued = false;
  const app = await load(testWorkspace, undefined, { extensionFactories: [pi => {
    pi.on("agent_before_settle", event => {
      if (!continued) {
        continued = true;
        return { continue: true, entries: [...event.entries, {
          type: "custom_message", customType: "fixture.continuation", content: "Continue the test run.", display: false,
        }] };
      }
    });
  }] });
  try {
    app.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } });
    let request = 0;
    const events: string[] = [];
    app.session.subscribe(event => events.push(event.type));
    await useModel(app, async () => {
      assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 0);
      request++;
      await writeFile(join(testWorkspace.cwd, "notes.txt"), `attempt ${request}\n`);
      return request === 1
        ? responseStream({ content: [], stopReason: "error", errorMessage: "503 Service unavailable" })
        : responseStream({ content: [{ type: "text", text: "Recovered." }] });
    });
    await app.session.prompt("Retry and continue.");
    assert.equal(request, 3, JSON.stringify({ events, continued }));
    assert.ok(events.includes("auto_retry_start"));
    assert.equal(events.filter(event => event === "agent_end").length, 3);
    assert.equal(events.filter(event => event === "agent_settled").length, 1);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 1);
    const total = (await app.diff({ scope: "session" })).details as any;
    assert.match(total.files[0].patch, /\+attempt 3/);
    assert.doesNotMatch(total.files[0].patch, /attempt [12]/);
  } finally { dispose(app.session); }
});

test("overflow compaction and its retry remain inside the same processing round", async () => {
  const testWorkspace = await fixture();
  const reasons: string[] = [];
  const app = await load(testWorkspace, undefined, { extensionFactories: [pi => {
    pi.on("session_before_compact", event => {
      reasons.push(event.reason);
      return { compaction: { summary: "Deterministic recovery summary.",
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    });
  }] });
  try {
    app.session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } });
    let request = 0;
    await useModel(app, async () => {
      assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 0);
      request++;
      if (request === 1) return responseStream({ stopReason: "toolUse", content: [
        { type: "toolCall", id: "save-before-overflow", name: "write", arguments: { path: "notes.txt", content: "before compaction\n" } },
      ] });
      if (request === 2) return responseStream({ content: [], stopReason: "error", errorMessage: "maximum context length exceeded" });
      return responseStream({ content: [{ type: "text", text: "Recovered after compaction." }] });
    });
    await app.session.prompt("Recover from overflow.");
    assert.equal(request, 3);
    assert.deepEqual(reasons, ["overflow"]);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 1);
    assert.match(((await app.diff({ scope: "session" })).details as any).files[0].patch, /\+before compaction/);
  } finally { dispose(app.session); }
});

for (const ending of ["abort", "error", "retry-exhausted"] as const) {
  test(`${ending} saves files already written before processing stopped`, { timeout: 10000 }, async () => {
    const testWorkspace = await fixture();
    const waiting = gate();
    const app = await load(testWorkspace);
    try {
      if (ending === "retry-exhausted") app.session.settingsManager.applyOverrides({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      });
      let request = 0;
      await useModel(app, async (_model, _context, options) => {
        if (request++ === 0) return responseStream({ stopReason: "toolUse", content: [
          { type: "toolCall", id: "save-file", name: "write", arguments: { path: "notes.txt", content: "written before stopping\n" } },
        ] });
        assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 0);
        waiting.open();
        if (ending === "abort") {
          const signal = options?.signal;
          assert.ok(signal);
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return responseStream({ content: [], stopReason: "aborted", errorMessage: "Test abort" });
        }
        return responseStream({ content: [], stopReason: "error", errorMessage: ending === "error" ? "Invalid request" : "503 Service unavailable" });
      });
      const running = app.session.prompt("Write before stopping.");
      if (ending === "abort") { await waiting.promise; await app.session.abort(); }
      await running;
      assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 1);
      assert.match(((await app.diff({ scope: "session" })).details as any).files[0].patch, /\+written before stopping/);
      assert.deepEqual(((await app.diff()).details as any).files, []);
      assert.equal(app.session.isIdle, true);
    } finally { dispose(app.session); }
  });
}
