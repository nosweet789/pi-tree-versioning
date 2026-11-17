import assert from "node:assert/strict";
import { mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { Check } from "typebox/value";
import { responseStream, useModel } from "./agent-fixture.ts";
import { gitIdentity, nestedRepository, setDepth } from "./nested-fixture.ts";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, git, load } from "./harness.ts";

test("a depth setting enrolls an ignored repository only for new sessions", async () => {
  const workspace = await fixture();
  const nested = join(workspace.cwd, "nested");
  await mkdir(nested);
  git(nested, "init", "-q");
  await writeFile(join(nested, "notes.txt"), "before\n");
  git(nested, "add", ".");
  await writeFile(join(workspace.cwd, ".gitignore"), "/nested/\n");
  const original = await load(workspace);
  try {
    assert.ok(original.session.extensionRunner.getCommand("tree-versioning-repository-depth"));
    await original.session.prompt("/tree-versioning-repository-depth 1");
    await original.session.reload();
    const catalog = (await original.checkpoints()).details as any;
    assert.deepEqual(catalog.coverage, { searchDepth: 0, repositories: ["."] });
    await original.session.prompt("/tree-versioning-repository-depth");
    assert.match(original.notices.at(-1)!.message, /Configured search depth: 1/);
    assert.match(original.notices.at(-1)!.message, /Session search depth: 0/);
  } finally { dispose(original.session); }
  const app = await load(workspace);
  try {
    const coverage = { searchDepth: 1, repositories: [".", "nested"] };
    assert.deepEqual(((await app.checkpoints()).details as any).coverage, coverage);
    await writeFile(join(nested, "notes.txt"), "after\n");
    const result = await app.diff();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual((result.details as any).coverage, coverage);
    assert.deepEqual((result.details as any).files.map((file: any) => [file.path, file.status]), [["nested/notes.txt", "modified"]]);
    assert.match((result.details as any).files[0].patch, /-before\n\+after/);
  } finally { dispose(app.session); }
});

for (const ignored of [true, false]) {
  test(`nested file history, coverage cards, and restoration respect each repository's own rules (parent ignored: ${ignored})`, async () => {
    const workspace = await fixture();
    const nested = await nestedRepository(workspace);
    if (ignored) await writeFile(join(workspace.cwd, ".gitignore"), "/nested/\n");
    await writeFile(join(nested, ".gitignore"), "*.ignored\n");
    await writeFile(join(nested, "tracked.ignored"), "tracked before\n");
    await writeFile(join(nested, "private.ignored"), "private before\n");
    await writeFile(join(nested, "deleted.txt"), "deleted before\n");
    await writeFile(join(nested, "image.bin"), Buffer.from([0, 1]));
    await symlink("notes.txt", join(nested, "link"));
    git(nested, "add", ".");
    git(nested, "add", "-f", "tracked.ignored");
    await setDepth(workspace, 1);
    const identities = await Promise.all([workspace.cwd, nested].map(gitIdentity));
    initTheme("dark", false);
    const app = await load(workspace);
    try {
      const baselineNode = app.manager.getLeafId()!;
      await writeFile(join(workspace.cwd, "notes.txt"), "parent after\n");
      await writeFile(join(nested, "notes.txt"), "nested after\n");
      await writeFile(join(nested, "tracked.ignored"), "tracked after\n");
      await writeFile(join(nested, "private.ignored"), "private after\n");
      await writeFile(join(nested, "added.txt"), "added\n");
      await unlink(join(nested, "deleted.txt"));
      await writeFile(join(nested, "image.bin"), Buffer.from([0, 2]));
      await unlink(join(nested, "link"));
      await symlink("missing", join(nested, "link"));
      const before = (await app.diff()).details as any;
      assert.deepEqual(before.files.map((file: any) => [file.path, file.status]), [
        ["nested/added.txt", "added"], ["nested/deleted.txt", "deleted"], ["nested/image.bin", "modified"],
        ["nested/link", "modified"], ["nested/notes.txt", "modified"], ["nested/tracked.ignored", "modified"], ["notes.txt", "modified"],
      ]);
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Save both repositories.");
      for (const scope of ["turn", "session"]) {
        const result = await app.diff({ scope });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.deepEqual((result.details as any).files, before.files);
        assert.deepEqual((result.details as any).coverage, { searchDepth: 1, repositories: [".", "nested"] });
        assert.equal(Check(app.session.extensionRunner.getToolDefinition("session_diff")!.outputSchema!, result.structuredContent), true);
      }
      const filtered = (await app.diff({ scope: "session", files: ["nested/notes.txt"] })).details as any;
      assert.deepEqual(filtered.files.map((file: any) => file.path), ["nested/notes.txt"]);
      const entry = app.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "tree-versioning.checkpoint") as CustomEntry;
      const mounted = new CustomEntryComponent(entry, app.session.extensionRunner.getEntryRenderer(entry.customType)!);
      assert.match(mounted.render(160).map(stripVTControlCharacters).join("\n"), /Covered repositories.*nested/);
      await app.command("zh-CN");
      assert.match(mounted.render(160).map(stripVTControlCharacters).join("\n"), /覆盖仓库.*nested/);
      await app.session.reload();
      assert.deepEqual(((await app.diff({ scope: "session" })).details as any).files, before.files);
      const checkpoint = ((await app.checkpoints()).details as any).checkpoints[0];
      await app.session.navigateTree(baselineNode, { summarize: false });
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
      assert.equal(await readFile(join(nested, "notes.txt"), "utf8"), "nested before\n");
      assert.equal(await readFile(join(nested, "tracked.ignored"), "utf8"), "tracked before\n");
      assert.equal(await readFile(join(nested, "deleted.txt"), "utf8"), "deleted before\n");
      await assert.rejects(readFile(join(nested, "added.txt")), { code: "ENOENT" });
      assert.deepEqual(await readFile(join(nested, "image.bin")), Buffer.from([0, 1]));
      assert.equal(await readlink(join(nested, "link")), "notes.txt");
      assert.equal(await readFile(join(nested, "private.ignored"), "utf8"), "private after\n");
      await app.session.navigateTree(checkpoint.nodeId, { summarize: false });
      assert.deepEqual(((await app.diff()).details as any).files, []);
      assert.deepEqual(await Promise.all([workspace.cwd, nested].map(gitIdentity)), identities);
    } finally { dispose(app.session); }
  });
}
