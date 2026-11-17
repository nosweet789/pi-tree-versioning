import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";
import { nestedRepository, setDepth } from "./nested-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

for (const damage of ["missing", "replaced", "symlink", "submodule", "unreadable"] as const) {
  test(`an enrolled repository becoming ${damage} cannot publish incomplete history or partially start restoration`, async t => {
    const workspace = await fixture();
    const nested = await nestedRepository(workspace);
    let blockAccess = false;
    if (damage === "unreadable") {
      const lstat = fs.lstat;
      let injected = false;
      const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (blockAccess && args[0] === join(nested, ".git")) {
          injected = true;
          throw Object.assign(new Error("Simulated inaccessible nested repository"), { code: "EACCES" });
        }
        return lstat(...args);
      });
      syncBuiltinESMExports();
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); assert.equal(injected, true); });
    }
    await setDepth(workspace, 1);
    const app = await load(workspace);
    try {
      const baselineNode = app.manager.getLeafId()!;
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(nested, "notes.txt"), "saved\n");
      await app.session.prompt("Save both repositories.");
      const saved = (await app.checkpoints()).details;
      await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
      if (damage === "submodule") {
        git(workspace.cwd, "update-index", "--add", "--cacheinfo", "160000", git(nested, "rev-parse", "HEAD").trim(), "nested");
      } else if (damage === "unreadable") {
        blockAccess = true;
      } else {
        await rename(nested, join(workspace.root, "original-nested"));
        if (damage === "replaced") await nestedRepository(workspace);
        if (damage === "symlink") await symlink(join(workspace.root, "original-nested"), nested);
      }
      const index = await readFile(join(workspace.cwd, ".git", "index"));
      const result = await app.diff();
      assert.equal(result.isError, true);
      assert.equal((result.details as any).code, "capture_failed");
      assert.equal((await app.diff({ scope: "session" })).isError, false);
      await app.session.prompt("A failed capture must not create a checkpoint.");
      assert.match(app.notices.at(-1)!.message, /This round was not recorded/);
      assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, (saved as any).checkpoints);
      await app.session.navigateTree(baselineNode, { summarize: false });
      assert.equal(app.manager.getLeafId(), baselineNode);
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
      assert.deepEqual(await readFile(join(workspace.cwd, ".git", "index")), index);
    } finally { dispose(app.session); }
  });
}

test("new nested ignore rules block restoration before any repository is modified", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  await writeFile(join(nested, "private.txt"), "initially managed\n");
  await setDepth(workspace, 1);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save before new ignore rules.");
    await writeFile(join(nested, ".gitignore"), "private.txt\n");
    await writeFile(join(nested, "private.txt"), "private edit\n");
    await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.equal(await readFile(join(nested, "private.txt"), "utf8"), "private edit\n");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
  } finally { dispose(app.session); }
});

for (const originalKind of ["file", "directory"] as const) {
  test(`an ordinary ${originalKind} becoming a new repository is not recorded as ordinary file deletion`, async () => {
    const workspace = await fixture();
    const nested = await nestedRepository(workspace);
    const path = join(nested, "converted");
    if (originalKind === "directory") await mkdir(path);
    await writeFile(originalKind === "file" ? path : join(path, "before.txt"), "managed before\n");
    await setDepth(workspace, 2);
    const app = await load(workspace);
    try {
      const baselineNode = app.manager.getLeafId()!;
      if (originalKind === "file") await rm(path);
      await nestedRepository(workspace, "nested/converted");
      await writeFile(join(workspace.cwd, "notes.txt"), "parent manual\n");
      assert.equal((await app.diff()).isError, true);
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Do not record a newly crossed repository boundary.");
      assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
      await app.session.navigateTree(baselineNode, { summarize: false });
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "parent manual\n");
      assert.equal(await readFile(join(path, "notes.txt"), "utf8"), "nested before\n");
    } finally { dispose(app.session); }
  });
}

test("an unreadable ignored search directory fails baseline creation instead of claiming complete coverage", async t => {
  const workspace = await fixture();
  await setDepth(workspace, 2);
  const directory = join(workspace.cwd, "ignored");
  await mkdir(directory);
  await writeFile(join(workspace.cwd, ".gitignore"), "/ignored/\n");
  const opendir = fs.opendir;
  let injected = false;
  const mocked = t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    if (args[0] === directory) {
      injected = true;
      throw Object.assign(new Error("Simulated search permission failure"), { code: "EACCES" });
    }
    return opendir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const app = await load(workspace);
  try {
    assert.equal(injected, true);
    assert.equal((await app.checkpoints()).isError, true);
    assert.equal(app.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline"), false);
    assert.ok(app.notices.some(notice => notice.type === "error"));
  } finally { dispose(app.session); }
});

test("repository search limits fail closed rather than publishing the discovered prefix", async () => {
  const workspace = await fixture();
  await setDepth(workspace, 1);
  await Promise.all(Array.from({ length: 10_001 }, (_, index) => writeFile(join(workspace.cwd, "entry-" + index), "")));
  const app = await load(workspace);
  try {
    assert.equal((await app.checkpoints()).isError, true);
    assert.equal(app.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline"), false);
    assert.ok(app.notices.some(notice => notice.type === "error"));
  } finally { dispose(app.session); }
});

test("legacy snapshots remain root-only after setting depth and can still record and restore", async () => {
  const workspace = await fixture();
  const nested = await nestedRepository(workspace);
  const app = await load(workspace);
  try {
    const baselineNode = app.manager.getLeafId()!;
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "saved parent\n");
    await app.session.prompt("Create history in the legacy envelope.");
    const storage = join(workspace.agentDir, "tree-versioning", app.manager.getSessionId());
    // Compatibility injection uses the old on-disk envelope; assertions use public behavior.
    for (const name of await readdir(storage)) {
      const path = join(storage, name);
      const { integrity: _integrity, repositoryScope: _scope, ...value } = JSON.parse(await readFile(path, "utf8"));
      value.version = 1;
      const integrity = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      await writeFile(path, JSON.stringify({ ...value, integrity }));
    }
    await app.session.prompt("/tree-versioning-repository-depth 1");
    await app.session.reload();
    assert.deepEqual(((await app.checkpoints()).details as any).coverage, { searchDepth: 0, repositories: ["."] });
    await writeFile(join(nested, "notes.txt"), "nested manual\n");
    assert.deepEqual(((await app.diff()).details as any).files, []);
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "continued parent\n");
    await app.session.prompt("Continue the legacy session.");
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 2);
    await app.session.navigateTree(baselineNode, { summarize: false });
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
    assert.equal(await readFile(join(nested, "notes.txt"), "utf8"), "nested manual\n");
  } finally { dispose(app.session); }
});
