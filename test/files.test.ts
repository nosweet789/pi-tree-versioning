import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("symbolic-link targets with non-UTF-8 bytes compare losslessly across reload", async () => {
  const testWorkspace = await fixture();
  const path = join(testWorkspace.cwd, "raw-link");
  await symlink(Buffer.from([0x80]), path);
  const app = await load(testWorkspace);
  try {
    assert.deepEqual(((await app.diff()).details as any).files, []);
    await unlink(path);
    await symlink(Buffer.from([0x81]), path);
    await app.session.reload();
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    const changes = (result.details as any).files;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].binary, true);
    assert.deepEqual(changes[0].before, { kind: "symlink", target: "gA==", targetEncoding: "base64" });
    assert.deepEqual(changes[0].after, { kind: "symlink", target: "gQ==", targetEncoding: "base64" });
  } finally { dispose(app.session); }
});

test("valid POSIX filenames survive persistence without being misclassified as corrupt paths", async () => {
  const testWorkspace = await fixture();
  const names = ["back\\slash.txt", "C:notes.txt", "toString", "__proto__"];
  for (const name of names) await writeFile(join(testWorkspace.cwd, name), "before\n");
  const app = await load(testWorkspace);
  try {
    const empty = await app.diff();
    assert.equal(empty.isError, false, JSON.stringify(empty));
    assert.deepEqual((empty.details as any).files, []);
    for (const name of names) await writeFile(join(testWorkspace.cwd, name), "after\n");
    await app.session.reload();
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual((result.details as any).files.map((file: any) => file.path), [...names].sort());
  } finally { dispose(app.session); }
});

test("managed files include tracked ignored paths and preserve binary and link states without following targets or submodules", async () => {
  const testWorkspace = await fixture();
  await writeFile(join(testWorkspace.cwd, ".gitignore"), "*.ignored\n");
  await writeFile(join(testWorkspace.cwd, "tracked.ignored"), "before\n");
  await writeFile(join(testWorkspace.cwd, "secret.ignored"), "not managed\n");
  await writeFile(join(testWorkspace.cwd, "image.bin"), Buffer.from([0, 255, 1]));
  await writeFile(join(testWorkspace.root, "outside.txt"), "outside before\n");
  await symlink(join(testWorkspace.root, "outside.txt"), join(testWorkspace.cwd, "link"));
  git(testWorkspace.cwd, "add", ".gitignore", "image.bin", "link");
  git(testWorkspace.cwd, "add", "-f", "tracked.ignored");
  git(testWorkspace.cwd, "update-index", "--add", "--cacheinfo", "160000", git(testWorkspace.cwd, "rev-parse", "HEAD").trim(), "vendor");
  await mkdir(join(testWorkspace.cwd, "vendor"));
  await writeFile(join(testWorkspace.cwd, "vendor", "private.txt"), "submodule before\n");
  const app = await load(testWorkspace);
  try {
    await writeFile(join(testWorkspace.root, "outside.txt"), "outside after\n");
    await writeFile(join(testWorkspace.cwd, "secret.ignored"), "still not managed\n");
    await writeFile(join(testWorkspace.cwd, "vendor", "private.txt"), "submodule after\n");
    await writeFile(join(testWorkspace.cwd, ".git", "excluded"), "internal data\n");
    assert.deepEqual(((await app.diff()).details as any).files, []);
    await writeFile(join(testWorkspace.cwd, "tracked.ignored"), "after\n");
    await writeFile(join(testWorkspace.cwd, "image.bin"), Buffer.from([0, 255, 2, 3]));
    await unlink(join(testWorkspace.cwd, "link"));
    await symlink("missing-target", join(testWorkspace.cwd, "link"));
    await unlink(join(testWorkspace.cwd, "notes.txt"));
    await writeFile(join(testWorkspace.cwd, "新增\tfile.txt"), "new file\n");
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    const files = (result.details as any).files;
    assert.deepEqual(files.map((file: any) => [file.path, file.status]), [
      ["image.bin", "modified"], ["link", "modified"], ["notes.txt", "deleted"],
      ["tracked.ignored", "modified"], ["新增\tfile.txt", "added"],
    ]);
    assert.equal(files[0].binary, true);
    assert.equal(files[0].patch, undefined);
    assert.equal(files[0].before.size, 3);
    assert.equal(files[0].after.size, 4);
    assert.equal(files[1].before.kind, "symlink");
    assert.equal(files[1].before.target, join(testWorkspace.root, "outside.txt"));
    assert.equal(files[1].after.target, "missing-target");
    assert.equal(await readFile(join(testWorkspace.root, "outside.txt"), "utf8"), "outside after\n");
    const head = git(testWorkspace.cwd, "rev-parse", "HEAD");
    const index = git(testWorkspace.cwd, "ls-files", "--stage");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save managed file states.");
    await app.session.reload();
    assert.deepEqual(((await app.diff({ scope: "session" })).details as any).files, files);
    assert.deepEqual(((await app.diff()).details as any).files, []);
    assert.equal(git(testWorkspace.cwd, "rev-parse", "HEAD"), head);
    assert.equal(git(testWorkspace.cwd, "ls-files", "--stage"), index);
  } finally { dispose(app.session); }
});
