import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { dispose, fixture, load } from "./harness.ts";

test("the status tool reports the effective switch without scanning Git or mutating files, preferences, or history", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const originalPath = process.env.PATH;
  try {
    const tool = app.session.extensionRunner.getToolDefinition("tree_versioning_status");
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: true });
    await app.session.prompt("/tree-versioning-restore off");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
    const preferencesPath = join(workspace.agentDir, "tree-versioning", "preferences.json");
    const preferences = await readFile(preferencesPath, "utf8");
    const entries = app.manager.getEntries();
    const leaf = app.manager.getLeafId();
    process.env.PATH = "";
    const result = await app.query("tree_versioning_status");
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { restoreEnabled: false });
    assert.deepEqual(result.details, result.structuredContent);
    assert.equal(Check(tool.outputSchema!, result.structuredContent), true);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { restoreEnabled: false });
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(app.manager.getLeafId(), leaf);
    assert.equal(await readFile(preferencesPath, "utf8"), preferences);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
    await app.command("zh-CN");
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
    await app.session.prompt("/tree-versioning-restore on");
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: true });
  } finally {
    process.env.PATH = originalPath;
    dispose(app.session);
  }
});
