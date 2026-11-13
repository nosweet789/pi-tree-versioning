import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fixture, load } from "./harness.ts";
import { responseStream, useModel, type TestApp } from "./agent-fixture.ts";

test("native session switching rebuilds only the destination history and never restores files", async () => {
  const testWorkspace = await fixture();
  let app = await load(testWorkspace);
  const services = (current: TestApp) => ({
    cwd: testWorkspace.cwd, agentDir: testWorkspace.agentDir,
    modelRuntime: current.modelRuntime, settingsManager: current.session.settingsManager,
    resourceLoader: current.session.resourceLoader, diagnostics: [],
  });
  const runtime = new AgentSessionRuntime(app.session, services(app), async options => {
    app = await load(testWorkspace, options.sessionManager, { sessionStartEvent: options.sessionStartEvent });
    return { session: app.session, services: services(app), diagnostics: [],
      extensionsResult: app.session.resourceLoader.getExtensions() };
  });
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "first session saved\n");
    await app.session.prompt("First session.");
    const firstCatalog = (await app.checkpoints()).details;
    const firstTotal = (await app.diff({ scope: "session" })).details;
    const firstSession = app.manager.getSessionFile()!;
    const firstId = app.manager.getSessionId();
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "hand edit across new session\n");
    await runtime.newSession();
    assert.notEqual(app.manager.getSessionId(), firstId);
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "hand edit across new session\n");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "second session saved\n");
    await app.session.prompt("Second session.");
    const secondCatalog = (await app.checkpoints()).details;
    const secondSession = app.manager.getSessionFile()!;
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "manual edit across switch\n");
    await runtime.switchSession(firstSession);
    assert.deepEqual((await app.checkpoints()).details, firstCatalog);
    assert.deepEqual((await app.diff({ scope: "session" })).details, firstTotal);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "manual edit across switch\n");
    await runtime.switchSession(secondSession);
    assert.deepEqual((await app.checkpoints()).details, secondCatalog);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "manual edit across switch\n");
  } finally { await runtime.dispose(); }
});
