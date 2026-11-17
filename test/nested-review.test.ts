import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { dispose, fixture, git, load } from "./harness.ts";
import { nestedRepository, setDepth } from "./nested-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("repository names sorting before a dot survive baseline publication and reload", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace, "!nested");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    await app.session.reload();
    const catalog = await app.checkpoints();
    assert.equal(catalog.isError, false, JSON.stringify(catalog));
    assert.deepEqual((catalog.details as any).coverage, { searchDepth: 1, repositories: [".", "!nested"] });
    await writeFile(join(nested, "notes.txt"), "after\n");
    assert.deepEqual(((await app.diff()).details as any).files.map((file: any) => file.path), ["!nested/notes.txt"]);
  } finally { dispose(app.session); }
});

test("one-character repository names own their files and restore through deeper nested repositories", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace, "a");
  const deeper = await nestedRepository(workspace, "a/b");
  await setDepth(workspace, 2);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    for (const directory of [workspace.cwd, nested, deeper]) await writeFile(join(directory, "notes.txt"), "after\n");
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual((result.details as any).files.map((file: any) => file.path), ["a/b/notes.txt", "a/notes.txt", "notes.txt"]);
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save files owned by short repository names.");
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(await readFile(join(nested, "notes.txt"), "utf8"), "nested before\n");
    assert.equal(await readFile(join(deeper, "notes.txt"), "utf8"), "nested before\n");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
  } finally { dispose(app.session); }
});

test("empty-directory removal permissions are checked before deleting any unsnapshotted file", async t => {
  if (process.getuid?.() === 0) { t.skip("Requires an unprivileged POSIX user for actual permission failures"); return; }
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  const blocked = join(nested, "replace");
  await writeFile(blocked, "saved file\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save before the file becomes a directory.");
    await rm(blocked);
    await mkdir(join(blocked, "empty"), { recursive: true });
    await writeFile(join(workspace.cwd, "unsaved.txt"), "must not be deleted\n");
    await chmod(blocked, 0o500);
    await assert.rejects(access(blocked, 2), { code: "EACCES" });
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.equal(await readFile(join(workspace.cwd, "unsaved.txt"), "utf8"), "must not be deleted\n");
    assert.deepEqual(await readdir(blocked), ["empty"]);
  } finally { await chmod(blocked, 0o700); dispose(app.session); }
});

test("an uninitialized gitlink replacing saved paths is not recorded as file deletion", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  await mkdir(join(nested, "converted"));
  await writeFile(join(nested, "converted", "before.txt"), "saved content\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    git(nested, "update-index", "--add", "--cacheinfo", "160000", git(nested, "rev-parse", "HEAD").trim(), "converted");
    await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
    assert.equal((await app.diff()).isError, true);
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Do not capture an indexed repository boundary as deletion.");
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
    assert.equal(await readFile(join(nested, "converted", "before.txt"), "utf8"), "saved content\n");
  } finally { dispose(app.session); }
});

test("indexed gitlink protection survives an ancestor link redirecting its filesystem location", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  const directory = join(nested, "directory");
  await mkdir(join(directory, "sub"), { recursive: true });
  await writeFile(join(directory, "sub", "child.txt"), "saved child\n");
  const outside = join(workspace.root, "outside");
  await mkdir(join(outside, "sub"), { recursive: true });
  await writeFile(join(outside, "sub", "child.txt"), "outside stays\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    git(nested, "update-index", "--add", "--cacheinfo", "160000", git(nested, "rev-parse", "HEAD").trim(), "directory/sub");
    await rm(directory, { recursive: true });
    await symlink(outside, directory);
    const result = await app.diff();
    assert.equal(result.isError, true, JSON.stringify(result));
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Keep the indexed submodule boundary despite an ancestor link.");
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
    assert.equal(await readFile(join(outside, "sub", "child.txt"), "utf8"), "outside stays\n");
  } finally { dispose(app.session); }
});

test("replacing saved descendants with a cyclic directory link records the link without following it", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  const directory = join(nested, "directory");
  await mkdir(directory);
  await writeFile(join(directory, "child.txt"), "saved child\n");
  git(nested, "add", "directory");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    await rm(directory, { recursive: true });
    await symlink("directory", directory);
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual((result.details as any).files.map((file: any) => [file.path, file.status]), [
      ["nested/directory", "added"], ["nested/directory/child.txt", "deleted"],
    ]);
    assert.equal((result.details as any).files[0].after.kind, "symlink");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Record the link itself, not its target.");
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 1);
    await app.session.reload();
    assert.deepEqual(((await app.diff()).details as any).files, []);
    assert.equal(await readlink(directory), "directory");
  } finally { dispose(app.session); }
});

test("Git warnings about unreadable directories cannot produce a partial snapshot or begin restoration", async t => {
  if (process.getuid?.() === 0) { t.skip("Requires an unprivileged POSIX user for actual permission failures"); return; }
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  const blocked = join(nested, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "untracked.txt"), "saved untracked file\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
    await chmod(blocked, 0o111);
    await assert.rejects(readdir(blocked), { code: "EACCES" });
    const result = await app.diff();
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal((result.details as any).code, "capture_failed");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Do not save a Git enumeration that skipped files.");
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
  } finally { await chmod(blocked, 0o700); dispose(app.session); }
});

test("an unwritable enrolled repository blocks all planned restoration writes during preflight", async t => {
  if (process.getuid?.() === 0) { t.skip("Requires an unprivileged POSIX user for actual permission failures"); return; }
  const workspace = await fixture();
  const nested = await nestedRepository(workspace, "z-nested");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save before permission changes.");
    await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
    await writeFile(join(nested, "notes.txt"), "nested manual\n");
    await chmod(nested, 0o500);
    await assert.rejects(access(nested, 2), { code: "EACCES" });
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
    assert.equal(await readFile(join(nested, "notes.txt"), "utf8"), "nested manual\n");
  } finally { await chmod(nested, 0o700); dispose(app.session); }
});

test("a busy preference lock fails without stealing the lock or changing saved choices", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const path = join(workspace.agentDir, "tree-versioning", "preferences.json");
  const lock = path + ".lock";
  try {
    await app.command("en");
    const before = await readFile(path, "utf8");
    await mkdir(lock);
    await app.session.prompt("/tree-versioning-repository-depth 1");
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.match(app.notices.at(-1)!.message, /lock is busy or stale/);
    assert.equal(await readFile(path, "utf8"), before);
    await access(lock);
    await rm(lock, { recursive: true });
    await app.session.prompt("/tree-versioning-repository-depth 1");
    assert.match(app.notices.at(-1)!.message, /search depth saved/);
  } finally { await rm(lock, { recursive: true, force: true }); dispose(app.session); }
});

test("simultaneous processes preserve workspace depths and the restoration choice", async () => {
  const workspace = await fixture();
  const other = { ...await fixture(), agentDir: workspace.agentDir };
  const initial = await load(workspace);
  try { await initial.command("en"); } finally { dispose(initial.session); }
  const barrier = join(workspace.root, "barrier");
  await mkdir(barrier);
  const execute = promisify(execFile);
  const tasks = [
    [workspace, "first", "/tree-versioning-repository-depth 1"],
    [other, "second", "/tree-versioning-repository-depth 2"],
    [workspace, "third", "/tree-versioning-restore off"],
  ] as const;
  const workers = tasks.map(([value, identity, command]) => execute(process.execPath, [
    "--import", "tsx", "test/preference-worker.ts", JSON.stringify(value), barrier, identity, command,
  ], { timeout: 20_000 }));
  const settled = Promise.allSettled(workers);
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await readdir(barrier)).length === tasks.length) break;
    await setTimeout(10);
  }
  assert.equal((await readdir(barrier)).length, tasks.length, "All writers must be ready before the race starts");
  await writeFile(join(barrier, "start"), "start");
  for (const result of await settled) assert.equal(result.status, "fulfilled", JSON.stringify(result));
  for (const [value, depth] of [[workspace, 1], [other, 2]] as const) {
    const app = await load(value);
    try {
      assert.deepEqual((await app.query("tree_versioning_status")).details, { restoreEnabled: false });
      await app.session.prompt("/tree-versioning-repository-depth");
      assert.ok(app.notices.at(-1)!.message.includes("Configured search depth: " + depth));
    } finally { dispose(app.session); }
  }
});
