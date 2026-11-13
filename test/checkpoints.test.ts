import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("a completed round records its final native node and survives extension reload", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Finished." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "saved round\n");
    await app.session.prompt("Record this round.");
    const result = await app.checkpoints();
    assert.equal(result.isError, false);
    const catalog = result.details as any;
    assert.equal(catalog.checkpoints.length, 1);
    const checkpoint = catalog.checkpoints[0];
    assert.equal(checkpoint.kind, "checkpoint");
    const finalNode = app.manager.getEntries().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
    assert.equal(checkpoint.nodeId, finalNode.id);
    assert.equal(catalog.current.snapshot.id, checkpoint.id);
    assert.equal(catalog.current.nodeId, app.manager.getLeafId());
    const entries = app.manager.getEntries();
    await app.session.reload();
    assert.deepEqual((await app.checkpoints()).details, catalog);
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
});

test("round, saved-session, and workspace queries compare independent endpoints without recording disk edits", async () => {
  const testWorkspace = await fixture();
  await writeFile(join(testWorkspace.cwd, "notes.txt"), "pre-existing edit\n");
  const app = await load(testWorkspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Finished." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "first round\n");
    await app.session.prompt("First round.");
    const first = ((await app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "second round\n");
    await writeFile(join(testWorkspace.cwd, "new.txt"), "new file\n");
    await app.session.prompt("Second round.");
    const second = ((await app.checkpoints()).details as any).checkpoints[1];
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "unsaved edit\n");
    const entries = app.manager.getEntries();
    const leaf = app.manager.getLeafId();

    const round = (await app.diff({ scope: "turn", files: ["@notes.txt"] })).details as any;
    assert.equal(round.status, "ok");
    assert.equal(round.from.id, first.id);
    assert.equal(round.to.id, second.id);
    assert.equal(round.scope, "turn");
    assert.deepEqual(round.files.map((file: any) => file.path), ["notes.txt"]);
    assert.match(round.files[0].patch, /-first round\n\+second round/);

    const total = (await app.diff({ scope: "session" })).details as any;
    assert.equal(total.from.kind, "baseline");
    assert.equal(total.to.id, second.id);
    assert.deepEqual(total.files.map((file: any) => file.path), ["new.txt", "notes.txt"]);
    assert.match(total.files[1].patch, /-pre-existing edit\n\+second round/);
    assert.doesNotMatch(JSON.stringify(total), /unsaved edit|committed/);

    const workspace = (await app.diff()).details as any;
    assert.equal(workspace.from.id, second.id);
    assert.equal(workspace.to.kind, "workspace");
    assert.match(workspace.files[0].patch, /-second round\n\+unsaved edit/);
    const earlier = (await app.diff({ scope: "turn", checkpointId: first.id })).details as any;
    assert.equal(earlier.from.kind, "baseline");
    assert.equal(earlier.to.id, first.id);
    assert.match(earlier.files[0].patch, /-pre-existing edit\n\+first round/);
    assert.deepEqual(((await app.diff({ scope: "session", files: [] })).details as any).files, []);
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(app.manager.getLeafId(), leaf);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "unsaved edit\n");
  } finally { dispose(app.session); }
});
