import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";
import { nestedRepository, setDepth } from "./nested-fixture.ts";

for (const depth of [0, 1, 2]) {
  test(`search depth ${depth} counts directories from the outer root without resetting at repositories`, async () => {
    const workspace = await fixture();
    const names = ["direct", "direct/deeper", "direct/deeper/bottom", "packages/project"];
    for (const path of names) await nestedRepository(workspace, path);
    await writeFile(join(workspace.cwd, ".gitignore"), "/direct/\n/packages/\n");
    await writeFile(join(workspace.cwd, "direct", ".gitignore"), "/deeper/\n");
    await setDepth(workspace, depth);
    const app = await load(workspace);
    try {
      const expected = depth === 0 ? [] : depth === 1 ? ["direct"] : ["direct", "direct/deeper", "packages/project"];
      assert.deepEqual(((await app.checkpoints()).details as any).coverage, { searchDepth: depth, repositories: [".", ...expected] });
      for (const path of names) await writeFile(join(workspace.cwd, path, "notes.txt"), "after\n");
      const result = await app.diff();
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.deepEqual((result.details as any).files.map((file: any) => file.path), expected.map(path => path + "/notes.txt").sort());
    } finally { dispose(app.session); }
  });
}

test("search excludes submodules, worktrees, administrative data, and directory symlinks", async () => {
  const workspace = await fixture();
  await nestedRepository(workspace, "vendor");
  git(workspace.cwd, "update-index", "--add", "--cacheinfo", "160000", git(workspace.cwd, "rev-parse", "HEAD").trim(), "vendor");
  git(workspace.cwd, "worktree", "add", "-q", "--detach", join(workspace.cwd, "work"), "HEAD");
  const outside = await fixture();
  await symlink(outside.cwd, join(workspace.cwd, "linked"));
  await nestedRepository(workspace, ".git/internal");
  const metadata = join(workspace.cwd, "administrative");
  git(workspace.cwd, "init", "--separate-git-dir", metadata);
  await setDepth(workspace, 3);
  const app = await load(workspace);
  try {
    assert.deepEqual(((await app.checkpoints()).details as any).coverage, { searchDepth: 3, repositories: ["."] });
    for (const path of [join(workspace.cwd, "vendor"), join(workspace.cwd, "work"), outside.cwd, join(metadata, "internal")]) {
      await writeFile(join(path, "notes.txt"), "excluded edit\n");
    }
    assert.deepEqual(((await app.diff()).details as any).files, []);
  } finally { dispose(app.session); }
});

test("redirected nested Git administrative directories are neither searched nor captured", async () => {
  const workspace = await fixture();
  const redirected = await nestedRepository(workspace, "redirected");
  const metadata = join(workspace.cwd, "separate-metadata");
  git(redirected, "init", "--separate-git-dir", metadata);
  await nestedRepository(workspace, "separate-metadata/internal");
  await setDepth(workspace, 2);
  const app = await load(workspace);
  try {
    assert.deepEqual(((await app.checkpoints()).details as any).coverage, { searchDepth: 2, repositories: ["."] });
    await writeFile(join(metadata, "private.txt"), "administrative content\n");
    await writeFile(join(metadata, "internal", "notes.txt"), "administrative edit\n");
    assert.deepEqual(((await app.diff()).details as any).files, []);
  } finally { dispose(app.session); }
});

test("an enrolled child's own ignore rules win over paths tracked by its parent", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  await writeFile(join(nested, ".gitignore"), "private.txt\n");
  await writeFile(join(nested, "private.txt"), "private before\n");
  const blob = git(workspace.cwd, "hash-object", "-w", join(nested, "private.txt")).trim();
  git(workspace.cwd, "update-index", "--add", "--cacheinfo", "100644", blob, "nested/private.txt");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    await writeFile(join(nested, "private.txt"), "private after\n");
    await writeFile(join(nested, "notes.txt"), "nested after\n");
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual((result.details as any).files.map((file: any) => file.path), ["nested/notes.txt"]);
  } finally { dispose(app.session); }
});

test("depth choices are workspace-specific, merge across runtimes, and preserve other preferences", async () => {
  const workspace = await fixture();
  const other = { ...await fixture(), agentDir: workspace.agentDir };
  const first = await load(workspace);
  const second = await load(other);
  try {
    await Promise.all([
      first.session.prompt("/tree-versioning-repository-depth 1"),
      second.session.prompt("/tree-versioning-repository-depth 2"),
      first.session.prompt("/tree-versioning-restore off"),
      second.command("zh-CN"),
    ]);
    await first.session.reload();
    await first.session.prompt("/tree-versioning-repository-depth");
    assert.match(first.notices.at(-1)!.message, /配置搜索深度：1/);
    await second.session.reload();
    await second.session.prompt("/tree-versioning-repository-depth");
    assert.match(second.notices.at(-1)!.message, /配置搜索深度：2/);
    assert.deepEqual((await second.query("tree_versioning_status")).details, { restoreEnabled: false });
    const path = join(workspace.agentDir, "tree-versioning", "preferences.json");
    const before = await readFile(path, "utf8");
    const entries = first.manager.getEntries();
    for (const value of ["", "help", "-1", "1.5", "Infinity", "9007199254740992", "2 extra"]) {
      await first.session.prompt("/tree-versioning-repository-depth " + value);
      assert.match(first.notices.at(-1)!.message, /配置搜索深度：1/);
    }
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(first.manager.getEntries(), entries);
  } finally { dispose(first.session, second.session); }
});

test("lowering depth and creating new repositories do not change an existing session's coverage", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  await writeFile(join(workspace.cwd, ".gitignore"), "/nested/\n/late/\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    await app.session.prompt("/tree-versioning-repository-depth 0");
    await nestedRepository(workspace, "late");
    await app.session.reload();
    assert.deepEqual(((await app.checkpoints()).details as any).coverage, { searchDepth: 1, repositories: [".", "nested"] });
    await writeFile(join(nested, "notes.txt"), "after\n");
    assert.deepEqual(((await app.diff()).details as any).files.map((file: any) => file.path), ["nested/notes.txt"]);
  } finally { dispose(app.session); }
  const next = await load(workspace);
  try {
    assert.deepEqual(((await next.checkpoints()).details as any).coverage, { searchDepth: 0, repositories: ["."] });
  } finally { dispose(next.session); }
});
