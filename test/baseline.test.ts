import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";

test("baseline includes pre-existing edits and workspace queries report only subsequent net changes", async () => {
  const testWorkspace = await fixture();
  await writeFile(join(testWorkspace.cwd, "notes.txt"), "already dirty\n");
  const head = git(testWorkspace.cwd, "rev-parse", "HEAD");
  const index = git(testWorkspace.cwd, "ls-files", "--stage");
  const app = await load(testWorkspace);
  try {
    const empty = await app.diff();
    assert.equal(empty.isError, false, JSON.stringify(empty));
    assert.deepEqual((empty.details as any).files, []);
    const leaf = app.manager.getLeafId();
    const entries = app.manager.getEntries();
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "after baseline\n");
    const result = await app.diff();
    assert.equal(result.isError, false);
    const data = result.details as any;
    assert.equal(data.scope, "workspace");
    assert.equal(data.from.kind, "baseline");
    assert.equal(data.from.sessionId, app.manager.getSessionId());
    assert.equal(data.to.kind, "workspace");
    assert.equal(data.to.workspaceRoot, testWorkspace.cwd);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0].path, "notes.txt");
    assert.match(data.files[0].patch, /-already dirty\n\+after baseline/);
    assert.doesNotMatch(data.files[0].patch, /committed/);
    assert.equal(app.manager.getLeafId(), leaf);
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(git(testWorkspace.cwd, "rev-parse", "HEAD"), head);
    assert.equal(git(testWorkspace.cwd, "ls-files", "--stage"), index);
  } finally { dispose(app.session); }
});

test("reload and reopening preserve the original baseline without overwriting hand edits", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  const initial = (await app.diff()).details as any;
  app.manager.appendMessage({ role: "user", content: "Persist this session", timestamp: Date.now() });
  const file = app.manager.getSessionFile()!;
  await writeFile(join(testWorkspace.cwd, "notes.txt"), "hand edit\n");
  try {
    const entries = app.manager.getEntries();
    await app.session.reload();
    const reloaded = (await app.diff()).details as any;
    assert.deepEqual(reloaded.from, initial.from);
    assert.equal(reloaded.files.length, 1);
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
  const reopened = await load(testWorkspace, SessionManager.open(file));
  try {
    const result = (await reopened.diff()).details as any;
    assert.deepEqual(result.from, initial.from);
    assert.equal(result.files.length, 1);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "hand edit\n");
  } finally { dispose(reopened.session); }
});
