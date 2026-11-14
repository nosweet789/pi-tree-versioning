import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { loadRuntime } from "./runtime-fixture.ts";
import { damageCheckpoint } from "./fault-fixture.ts";

for (const operation of ["fork", "clone"] as const) {
  test(`${operation} rebinds a checkpoint recorded at a label recreated by the host`, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace, undefined, { extensionFactories: [pi => {
      pi.on("turn_end", (_event, ctx) => { pi.setLabel(ctx.sessionManager.getLeafId()!, "saved round"); });
    }] });
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "labeled checkpoint\n");
      await host.app.session.prompt("Save a labeled round.");
      const checkpoint = ((await host.app.checkpoints()).details as any).checkpoints[0];
      assert.equal(host.app.manager.getEntry(checkpoint.nodeId)?.type, "label");
      const next = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "labeled hand edit\n");
      await host.runtime.fork(next, { position: operation === "fork" ? "before" : "at" });
      const result = await host.app.checkpoints();
      assert.equal(result.isError, false, JSON.stringify(result.details));
      const catalog = result.details as any;
      assert.equal(catalog.current.snapshot.id, checkpoint.id);
      assert.ok(host.app.manager.getEntry(catalog.current.snapshot.nodeId));
      assert.equal((await host.app.diff({ scope: "turn" })).isError, false);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), operation === "fork" ? "labeled checkpoint\n" : "labeled hand edit\n");
      await host.app.session.reload();
      assert.equal((await host.app.checkpoints()).isError, false);
    } finally { await host.runtime.dispose(); }
  });

  test(`${operation} preserves coverage when the host recreates a baseline's label anchor`, async () => {
    const workspace = await fixture();
    const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
    const oldUser = manager.appendMessage({ role: "user", content: "Old history", timestamp: Date.now() });
    manager.appendThinkingLevelChange("off");
    const oldAnchor = manager.appendLabelChange(oldUser, "bookmark");
    const host = await loadRuntime(workspace, manager);
    try {
      const baseline = ((await host.app.checkpoints()).details as any).baseline;
      assert.equal(baseline.anchorId, oldAnchor);
      const next = manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edits\n");
      await host.runtime.fork(next, { position: operation === "fork" ? "before" : "at" });
      const catalog = (await host.app.checkpoints()).details as any;
      assert.equal(catalog.baseline.id, baseline.id);
      assert.equal(catalog.current.snapshot?.id, baseline.id);
      assert.ok(host.app.manager.getEntry(catalog.baseline.anchorId));
      assert.equal((await host.app.diff({ scope: "session" })).isError, false);
      assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), operation === "fork" ? "committed\n" : "manual edits\n");
    } finally { await host.runtime.dispose(); }
  });

  test(`native ${operation} inherits history in an ephemeral session across runtime replacement`, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace, SessionManager.inMemory(workspace.cwd));
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "ephemeral checkpoint\n");
      await host.app.session.prompt("Save the source round.");
      const source = (await host.app.checkpoints()).details as any;
      const next = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "ephemeral hand edit\n");
      await host.runtime.fork(next, { position: operation === "fork" ? "before" : "at" });
      const result = await host.app.checkpoints();
      assert.equal(result.isError, false, JSON.stringify(result.details));
      const child = result.details as any;
      assert.notEqual(child.sessionId, source.sessionId);
      assert.equal(child.baseline.id, source.baseline.id);
      assert.equal(child.current.snapshot.id, source.checkpoints[0].id);
      assert.equal(host.app.manager.getSessionFile(), undefined);
      assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
      const expected = operation === "fork" ? "ephemeral checkpoint\n" : "ephemeral hand edit\n";
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), expected);
      await host.app.session.reload();
      assert.equal(((await host.app.checkpoints()).details as any).baseline.id, source.baseline.id);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), expected);
    } finally { await host.runtime.dispose(); }
  });
}

test("cloning a labeled branch excludes abandoned snapshots and supports another generation of inheritance", async () => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "shared checkpoint\n");
    await host.app.session.prompt("Save shared history.");
    const first = ((await host.app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(workspace.cwd, "notes.txt"), "abandoned checkpoint\n");
    await host.app.session.prompt("Save abandoned history.");
    const abandoned = ((await host.app.checkpoints()).details as any).checkpoints[1];
    await host.app.session.navigateTree(first.nodeId, { summarize: false });
    host.app.manager.appendLabelChange(first.nodeId, "shared");
    await writeFile(join(workspace.cwd, "notes.txt"), "selected branch\n");
    await host.app.session.prompt("Save selected history.");
    const selected = ((await host.app.checkpoints()).details as any).checkpoints[2];
    const sourceId = host.app.manager.getSessionId();
    await damageCheckpoint(workspace, sourceId, abandoned.id, "missing");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual changes retained\n");
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    const result = await host.app.checkpoints();
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const child = result.details as any;
    assert.deepEqual(child.checkpoints.map((checkpoint: any) => checkpoint.id).sort(), [first.id, selected.id].sort());
    assert.equal(host.app.manager.getLabel(first.nodeId), "shared");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual changes retained\n");
    const round = (await host.app.diff({ scope: "turn", checkpointId: selected.id })).details as any;
    assert.equal(round.from.id, first.id);
    assert.match(round.files[0].patch, /-shared checkpoint\n\+selected branch/);
    await host.runtime.fork(first.nodeId, { position: "at" });
    const grandchild = (await host.app.checkpoints()).details as any;
    assert.deepEqual(grandchild.checkpoints.map((checkpoint: any) => checkpoint.id), [first.id]);
    assert.equal(grandchild.baseline.id, child.baseline.id);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual changes retained\n");
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "grandchild round\n");
    await host.app.session.prompt("Continue inherited history.");
    const continuation = (await host.app.diff({ scope: "turn" })).details as any;
    assert.equal(continuation.from.id, first.id);
    assert.match(continuation.files[0].patch, /-shared checkpoint\n\+grandchild round/);
  } finally { await host.runtime.dispose(); }
});

test("an empty fork inherits a late baseline without pretending it covers earlier history", async () => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  const firstUser = manager.appendMessage({ role: "user", content: "Before activation", timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "Activate here", timestamp: Date.now() });
  const host = await loadRuntime(workspace, manager);
  try {
    const baseline = ((await host.app.checkpoints()).details as any).baseline;
    await writeFile(join(workspace.cwd, "notes.txt"), "uncovered edits stay\n");
    await host.runtime.fork(firstUser);
    const result = await host.app.checkpoints();
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const catalog = result.details as any;
    assert.equal(catalog.baseline.id, baseline.id);
    assert.equal(catalog.current.snapshot, null);
    assert.deepEqual(catalog.checkpoints, []);
    assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
    assert.match(host.app.notices.at(-1)!.message, /No usable file history/);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "uncovered edits stay\n");
    await host.app.session.reload();
    assert.equal(((await host.app.checkpoints()).details as any).baseline.id, baseline.id);
    assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
  } finally { await host.runtime.dispose(); }
});

test("a cloned child survives source deletion and restores inherited history in a fresh process", async () => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  let sessionFile: string;
  let expected: any;
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "inherited first\n");
    await host.app.session.prompt("First saved round.");
    await writeFile(join(workspace.cwd, "notes.txt"), "inherited second\n");
    await host.app.session.prompt("Second saved round.");
    const sourceFile = host.app.manager.getSessionFile()!;
    const sourceId = host.app.manager.getSessionId();
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    sessionFile = host.app.manager.getSessionFile()!;
    expected = { catalog: (await host.app.checkpoints()).details, total: (await host.app.diff({ scope: "session" })).details };
    await rm(sourceFile);
    await rm(join(workspace.agentDir, "tree-versioning", sourceId), { recursive: true });
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit across restart\n");
    await host.app.session.reload();
    assert.deepEqual((await host.app.checkpoints()).details, expected.catalog);
  } finally { await host.runtime.dispose(); }
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "test/inheritance-reopen-worker.ts", JSON.stringify(workspace), sessionFile!,
    JSON.stringify(expected.catalog.checkpoints.map((checkpoint: any) => checkpoint.nodeId)),
  ], { timeout: 30000 });
  const reopened = JSON.parse(stdout);
  assert.equal(reopened.initial, "manual edit across restart\n");
  assert.deepEqual(reopened.catalog, expected.catalog);
  assert.deepEqual(reopened.total, expected.total);
  assert.deepEqual(reopened.restored, ["inherited first\n", "inherited second\n"]);
  assert.deepEqual(reopened.errors, []);
});

test("forking at a checkpoint inherits it even when its later association entry was not copied", async () => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "checkpoint on shared ancestry\n");
    await host.app.session.prompt("Save shared history.");
    const first = ((await host.app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(workspace.cwd, "notes.txt"), "abandoned branch\n");
    await host.app.session.prompt("Save the other branch.");
    await host.app.session.navigateTree(first.nodeId, { summarize: false });
    await writeFile(join(workspace.cwd, "notes.txt"), "new branch\n");
    await host.app.session.prompt("Fork before this request.");
    const user = host.app.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
    await host.runtime.fork(user.id);
    assert.equal(host.app.manager.getLeafId(), first.nodeId);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "checkpoint on shared ancestry\n");
    const catalog = (await host.app.checkpoints()).details as any;
    assert.deepEqual(catalog.checkpoints.map((checkpoint: any) => checkpoint.id), [first.id]);
    assert.equal(catalog.current.snapshot.id, first.id);
    assert.match(host.app.notices.at(-1)!.message, /Restored checkpoint/);
    const round = (await host.app.diff({ scope: "turn", checkpointId: first.id })).details as any;
    assert.match(round.files[0].patch, /-committed\n\+checkpoint on shared ancestry/);
  } finally { await host.runtime.dispose(); }
});

test("native forking restores its actual predecessor and leaves later source checkpoints intact", async () => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "first saved round\n");
    await host.app.session.prompt("First round.");
    const first = ((await host.app.checkpoints()).details as any).checkpoints[0];
    const destination = host.app.manager.getLeafId();
    await writeFile(join(workspace.cwd, "notes.txt"), "later saved round\n");
    await host.app.session.prompt("Try another approach.");
    const selected = host.app.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
    const sourceFile = host.app.manager.getSessionFile()!;
    const sourceCatalog = (await host.app.checkpoints()).details;
    await writeFile(join(workspace.cwd, "notes.txt"), "unsaved work\n");
    const result = await host.runtime.fork(selected.id);
    assert.equal(result.cancelled, false);
    assert.equal(result.selectedText, "Try another approach.");
    assert.equal(host.app.manager.getLeafId(), destination);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "first saved round\n");
    const catalog = (await host.app.checkpoints()).details as any;
    assert.deepEqual(catalog.checkpoints.map((checkpoint: any) => checkpoint.id), [first.id]);
    assert.match(host.app.notices.at(-1)!.message, /nearest preceding checkpoint/);
    assert.ok(host.app.notices.at(-1)!.message.includes(first.id));
    assert.deepEqual(((await host.app.diff()).details as any).files, []);
    await host.runtime.switchSession(sourceFile);
    assert.deepEqual((await host.app.checkpoints()).details, sourceCatalog);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "first saved round\n");
  } finally { await host.runtime.dispose(); }
});

test("native cloning inherits the source baseline and checkpoint without restoring unsnapshotted edits", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "notes.txt"), "before session\n");
  const host = await loadRuntime(workspace);
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "saved clone\n");
    await host.app.session.prompt("Record the source round.");
    const source = (await host.app.checkpoints()).details as any;
    const records = host.app.manager.getEntries().filter(entry => entry.type === "custom");
    const originalSession = host.app.session;
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
    assert.equal((await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" })).cancelled, false);
    assert.notEqual(host.app.session, originalSession);
    const result = await host.app.checkpoints();
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const child = result.details as any;
    assert.notEqual(child.sessionId, source.sessionId);
    assert.equal(child.baseline.id, source.baseline.id);
    assert.equal(child.baseline.sessionId, child.sessionId);
    assert.equal(child.checkpoints.length, 1);
    assert.equal(child.checkpoints[0].id, source.checkpoints[0].id);
    assert.equal(child.checkpoints[0].nodeId, source.checkpoints[0].nodeId);
    assert.equal(child.checkpoints[0].sessionId, child.sessionId);
    assert.deepEqual(host.app.manager.getEntries().filter(entry => entry.type === "custom"), records);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
    const total = (await host.app.diff({ scope: "session" })).details as any;
    assert.equal(total.from.id, source.baseline.id);
    assert.match(total.files[0].patch, /-before session\n\+saved clone/);
    const unsaved = (await host.app.diff()).details as any;
    assert.equal(unsaved.from.id, source.checkpoints[0].id);
    assert.match(unsaved.files[0].patch, /-saved clone\n\+manual edit stays/);
  } finally { await host.runtime.dispose(); }
});
