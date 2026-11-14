import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("native navigation restores the checkpoint itself with replacement, creation, and deletion", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    await app.command("en");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "saved edit\n");
    await writeFile(join(workspace.cwd, "saved.txt"), "saved new file\n");
    await app.session.prompt("Record target state.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(workspace.cwd, "notes.txt"), "later edit\n");
    await rm(join(workspace.cwd, "saved.txt"));
    await writeFile(join(workspace.cwd, "later.txt"), "later file\n");
    await app.session.prompt("Record later state.");
    await writeFile(join(workspace.cwd, "unsaved.txt"), "no backup\n");
    const entries = app.manager.getEntries();
    const head = git(workspace.cwd, "rev-parse", "HEAD");
    const index = await readFile(join(workspace.cwd, ".git", "index"));
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(app.manager.getLeafId(), target.nodeId);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "saved edit\n");
    assert.equal(await readFile(join(workspace.cwd, "saved.txt"), "utf8"), "saved new file\n");
    assert.deepEqual((await readdir(workspace.cwd)).sort(), [".git", "notes.txt", "saved.txt"]);
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(workspace.cwd, ".git", "index")), index);
    assert.deepEqual(((await app.diff()).details as any).files, []);
    assert.match(app.notices.at(-1)!.message, /Restored checkpoint/);
    assert.ok(app.notices.at(-1)!.message.includes(target.id));
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});
