import assert from "node:assert/strict";
import { link, mkdir, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("restoration replaces cyclic leaf links even when the index still names descendants", async () => {
  const workspace = await fixture();
  await mkdir(join(workspace.cwd, "nested"));
  await writeFile(join(workspace.cwd, "nested", "child.txt"), "tracked child\n");
  git(workspace.cwd, "add", "nested");
  const app = await load(workspace);
  try {
    await rm(join(workspace.cwd, "nested"), { recursive: true });
    await symlink("missing-saved-target", join(workspace.cwd, "nested"));
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save a leaf link instead of the indexed directory.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await rm(join(workspace.cwd, "nested"));
    await symlink("nested", join(workspace.cwd, "nested"));
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(app.manager.getLeafId(), target.nodeId);
    assert.equal(await readlink(join(workspace.cwd, "nested")), "missing-saved-target");
    assert.equal(app.notices.at(-1)!.type, "info");
    const comparison = await app.diff();
    assert.equal(comparison.isError, false);
    assert.deepEqual((comparison.details as any).files, []);
  } finally { dispose(app.session); }
});

test("filesystem case aliases cannot bypass protection of relocated Git administrative data", async t => {
  const workspace = await fixture();
  await mkdir(join(workspace.cwd, "Metadata"));
  await writeFile(join(workspace.cwd, "Metadata", "config"), "ordinary file, not Git configuration\n");
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save a case-variant ordinary path.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await rm(join(workspace.cwd, "Metadata"), { recursive: true });
    const metadata = join(workspace.cwd, "metadata");
    git(workspace.cwd, "init", "--separate-git-dir", metadata);
    const alias = await realpath(join(workspace.cwd, "Metadata")).catch(() => undefined);
    if (alias !== await realpath(metadata)) { t.skip("This volume has case-sensitive paths"); return; }
    const config = await readFile(join(metadata, "config"));
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(app.manager.getLeafId(), target.nodeId);
    assert.deepEqual(await readFile(join(metadata, "config")), config);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
    assert.equal(app.notices.at(-1)!.type, "error");
  } finally { dispose(app.session); }
});

for (const linkKind of ["symbolic", "hard"] as const) {
  test(`restoration replaces a ${linkKind} leaf link without changing its outside target`, async () => {
    const workspace = await fixture();
    const outside = join(workspace.root, "outside.txt");
    await writeFile(outside, "outside stays\n");
    await symlink("missing-original-target", join(workspace.cwd, "saved-link"));
    const app = await load(workspace);
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Save regular and symbolic files.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      await rm(join(workspace.cwd, "notes.txt"));
      if (linkKind === "symbolic") await symlink(outside, join(workspace.cwd, "notes.txt"));
      else await link(outside, join(workspace.cwd, "notes.txt"));
      await rm(join(workspace.cwd, "saved-link"));
      await writeFile(join(workspace.cwd, "saved-link"), "regular file replaces saved link\n");
      await app.session.navigateTree(target.nodeId, { summarize: false });
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
      assert.equal(await readlink(join(workspace.cwd, "saved-link")), "missing-original-target");
      assert.equal(await readFile(outside, "utf8"), "outside stays\n");
      assert.equal(app.notices.at(-1)!.type, "info");
    } finally { dispose(app.session); }
  });
}

for (const blocker of ["parent-link", "submodule", "ignored-child", "git-child"] as const) {
  test(`restoration protects ${blocker} content before mutating any managed files`, async () => {
    const workspace = await fixture();
    if (blocker === "parent-link" || blocker === "submodule") {
      await mkdir(join(workspace.cwd, "protected"));
      await writeFile(join(workspace.cwd, "protected", "secret.txt"), "saved nested file\n");
      if (blocker === "parent-link") git(workspace.cwd, "add", "protected");
    } else await writeFile(join(workspace.cwd, "protected"), "saved regular file\n");
    const app = await load(workspace);
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Save the original scope.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
      await rm(join(workspace.cwd, "protected"), { recursive: true });
      if (blocker === "parent-link") {
        await writeFile(join(workspace.root, "secret.txt"), "outside stays\n");
        await symlink(workspace.root, join(workspace.cwd, "protected"));
      } else {
        await mkdir(join(workspace.cwd, "protected"));
        if (blocker === "git-child") await mkdir(join(workspace.cwd, "protected", ".git"));
        else await writeFile(join(workspace.cwd, "protected", "secret.txt"), "excluded content stays\n");
        if (blocker === "ignored-child") await writeFile(join(workspace.cwd, ".gitignore"), "protected/secret.txt\n");
        if (blocker === "submodule") git(workspace.cwd, "update-index", "--add", "--cacheinfo", "160000", git(workspace.cwd, "rev-parse", "HEAD").trim(), "protected");
      }
      const index = await readFile(join(workspace.cwd, ".git", "index"));
      await app.session.navigateTree(target.nodeId, { summarize: false });
      assert.equal(app.manager.getLeafId(), target.nodeId);
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
      if (blocker === "parent-link") assert.equal(await readFile(join(workspace.root, "secret.txt"), "utf8"), "outside stays\n");
      else if (blocker === "git-child") assert.deepEqual(await readdir(join(workspace.cwd, "protected", ".git")), []);
      else assert.equal(await readFile(join(workspace.cwd, "protected", "secret.txt"), "utf8"), "excluded content stays\n");
      assert.deepEqual(await readFile(join(workspace.cwd, ".git", "index")), index);
    } finally { dispose(app.session); }
  });
}

for (const damage of ["traversal", "git-path", "conflicting-paths", "link-null"] as const) {
  test(`a checksum-valid snapshot with ${damage} is rejected before any writes`, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    try {
      const storage = join(workspace.agentDir, "tree-versioning", app.manager.getSessionId());
      const previous = new Set(await readdir(storage));
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Record snapshot to damage.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      const name = (await readdir(storage)).find(name => !previous.has(name))!;
      const path = join(storage, name);
      const { integrity: _integrity, ...data } = JSON.parse(await readFile(path, "utf8"));
      const state = { kind: "file", content: Buffer.from("must not escape\n").toString("base64"), executable: false };
      if (damage === "traversal") data.files["../outside.txt"] = state;
      if (damage === "git-path") data.files[".GIT/config"] = state;
      if (damage === "conflicting-paths") { data.files.conflict = state; data.files["conflict/child"] = state; }
      if (damage === "link-null") data.files.invalid = { kind: "symlink", target: "AA==", targetEncoding: "base64" };
      // Fault injection intentionally knows the storage envelope; assertions use only public effects.
      const integrity = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      await writeFile(path, JSON.stringify({ ...data, integrity }));
      await writeFile(join(workspace.root, "outside.txt"), "outside stays\n");
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
      const config = await readFile(join(workspace.cwd, ".git", "config"));
      await app.session.navigateTree(target.nodeId, { summarize: false });
      assert.equal(app.manager.getLeafId(), target.nodeId);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
      assert.equal(await readFile(join(workspace.root, "outside.txt"), "utf8"), "outside stays\n");
      assert.deepEqual(await readFile(join(workspace.cwd, ".git", "config")), config);
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.match(app.notices.at(-1)!.message, /no files were restored/);
    } finally { dispose(app.session); }
  });
}

test("file and directory transitions remove only managed descendants and create required parents", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "former-directory"), "target file\n");
  await mkdir(join(workspace.cwd, "former-file"));
  await writeFile(join(workspace.cwd, "former-file", "child.txt"), "target child\n");
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Record target topology.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await rm(join(workspace.cwd, "former-directory"));
    await mkdir(join(workspace.cwd, "former-directory"));
    await writeFile(join(workspace.cwd, "former-directory", "unsaved.txt"), "remove me\n");
    await rm(join(workspace.cwd, "former-file"), { recursive: true });
    await writeFile(join(workspace.cwd, "former-file"), "replace with directory\n");
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(app.notices.at(-1)!.type, "info", app.notices.at(-1)!.message);
    assert.equal(await readFile(join(workspace.cwd, "former-directory"), "utf8"), "target file\n");
    assert.equal(await readFile(join(workspace.cwd, "former-file", "child.txt"), "utf8"), "target child\n");
    assert.deepEqual(((await app.diff()).details as any).files, []);
  } finally { dispose(app.session); }
});

test("restoration refuses to overwrite a saved path that is now untracked and ignored", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "private.txt"), "previously managed\n");
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Record the managed path.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(workspace.cwd, ".gitignore"), "private.txt\n");
    await writeFile(join(workspace.cwd, "private.txt"), "ignored private content\n");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(app.manager.getLeafId(), target.nodeId);
    assert.equal(await readFile(join(workspace.cwd, "private.txt"), "utf8"), "ignored private content\n");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
    assert.equal(await readFile(join(workspace.cwd, ".gitignore"), "utf8"), "private.txt\n");
    assert.equal(app.notices.at(-1)!.type, "error");
    assert.match(app.notices.at(-1)!.message, /restoration failed/);
  } finally { dispose(app.session); }
});
