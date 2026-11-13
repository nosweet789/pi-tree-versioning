import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, git, load } from "./harness.ts";

test("an existing in-workspace session cannot acquire self-referential baseline metadata", async () => {
  const testWorkspace = await fixture();
  const manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.cwd, "sessions"));
  manager.appendMessage({ role: "user", content: "Existing session", timestamp: Date.now() });
  manager.appendThinkingLevelChange("off");
  const path = manager.getSessionFile()!;
  const before = await readFile(path);
  const app = await load(testWorkspace, manager);
  try {
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.equal((await app.diff()).isError, true);
    assert.deepEqual(await readFile(path), before);
  } finally { dispose(app.session); }
});

test("baseline capture rejects an agent data directory inside the managed workspace before writing snapshots", async () => {
  const testWorkspace = await fixture();
  testWorkspace.agentDir = join(testWorkspace.cwd, ".pi", "agent");
  await mkdir(testWorkspace.agentDir, { recursive: true });
  const app = await load(testWorkspace);
  try {
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.equal((await app.diff()).isError, true);
    assert.equal((await readdir(testWorkspace.agentDir)).includes("tree-versioning"), false);
  } finally { dispose(app.session); }
});

test("temporary output cannot be written to an in-workspace directory beginning with two dots", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = join(testWorkspace.cwd, "..cache");
    await mkdir(process.env.TMPDIR);
    await writeFile(join(testWorkspace.cwd, "large.txt"), "large line\n".repeat(6000));
    const result = await app.diff();
    assert.equal(result.isError, true);
    assert.deepEqual(await readdir(process.env.TMPDIR), []);
  } finally {
    process.env.TMPDIR = previous;
    dispose(app.session);
  }
});

test("snapshot storage refuses a session-directory symlink and leaves its target untouched", async () => {
  const testWorkspace = await fixture();
  const manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.root, "sessions"));
  const storage = join(testWorkspace.agentDir, "tree-versioning");
  const outside = join(testWorkspace.root, "outside-storage");
  await mkdir(storage);
  await mkdir(outside);
  await symlink(outside, join(storage, manager.getSessionId()));
  const app = await load(testWorkspace, manager);
  try {
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.equal((await app.diff()).isError, true);
    assert.deepEqual(await readdir(outside), []);
  } finally { dispose(app.session); }
});

test("Git administrative files are excluded even when the Git directory has a nonstandard in-workspace name", async () => {
  const testWorkspace = await fixture();
  const administrative = join(testWorkspace.cwd, "repository-metadata");
  git(testWorkspace.cwd, "init", "--separate-git-dir", administrative);
  const app = await load(testWorkspace);
  try {
    await writeFile(join(administrative, "private-internal-data"), "not workspace content\n");
    assert.deepEqual(((await app.diff()).details as any).files, []);
  } finally { dispose(app.session); }
});

test("reopening a session in a different workspace cannot use its saved baseline", async () => {
  const original = await fixture();
  const app = await load(original);
  app.manager.appendMessage({ role: "user", content: "Persist session", timestamp: Date.now() });
  const sessionFile = app.manager.getSessionFile()!;
  dispose(app.session);
  const other = await fixture();
  const reopened = await load({ ...other, agentDir: original.agentDir }, SessionManager.open(sessionFile, undefined, other.cwd));
  try {
    const result = await reopened.diff();
    assert.equal(result.isError, true);
    assert.equal((result.details as any).code, "workspace_mismatch");
    assert.equal(reopened.notices.at(-1)?.type, "error");
    assert.equal(await readFile(join(other.cwd, "notes.txt"), "utf8"), "committed\n");
  } finally { dispose(reopened.session); }
});

test("collection from a repository subdirectory never follows a replaced parent directory link", async () => {
  const testWorkspace = await fixture();
  await mkdir(join(testWorkspace.cwd, "nested"));
  await writeFile(join(testWorkspace.cwd, "nested", "secret.txt"), "inside\n");
  await writeFile(join(testWorkspace.root, "secret.txt"), "outside secret\n");
  git(testWorkspace.cwd, "add", "nested");
  const app = await load({ ...testWorkspace, cwd: join(testWorkspace.cwd, "nested") });
  try {
    await rm(join(testWorkspace.cwd, "nested"), { recursive: true });
    await symlink(testWorkspace.root, join(testWorkspace.cwd, "nested"));
    // Continue querying from the repository root after the caller's cwd disappears.
    dispose(app.session);
    const reopened = await load(testWorkspace, app.manager);
    try {
      const result = await reopened.diff();
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /outside secret/);
      assert.equal((result.details as any).files.find((file: any) => file.path === "nested/secret.txt").status, "deleted");
    } finally { dispose(reopened.session); }
  } finally { dispose(app.session); }
});
