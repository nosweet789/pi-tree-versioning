import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("both query contracts remain structured, read-only, and language-independent after a recorded round", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(testWorkspace.cwd, "中文-path.txt"), "original text\n");
    await app.session.prompt("Record a round.");
    await app.command("en");
    const entries = app.manager.getEntries();
    const catalog = await app.checkpoints();
    const comparisons = await Promise.all(["workspace", "turn", "session"].map(scope => app.diff({ scope })));
    await app.command("zh-CN");
    const preferencePath = join(testWorkspace.agentDir, "tree-versioning", "preferences.json");
    const preference = await readFile(preferencePath, "utf8");
    const localizedCatalog = await app.checkpoints();
    assert.deepEqual(localizedCatalog.details, catalog.details);
    assert.match(localizedCatalog.content[0].type === "text" ? localizedCatalog.content[0].text : "", /可用检查点/);
    for (const [index, scope] of ["workspace", "turn", "session"].entries()) {
      const localized = await app.diff({ scope });
      assert.deepEqual(localized.details, comparisons[index].details);
      assert.deepEqual(localized.structuredContent, localized.details);
      const schema = app.session.extensionRunner.getToolDefinition("session_diff")!.outputSchema!;
      assert.equal(Check(schema, localized.structuredContent), true);
    }
    const schema = app.session.extensionRunner.getToolDefinition("session_checkpoints")!.outputSchema!;
    assert.equal(Check(schema, localizedCatalog.structuredContent), true);
    assert.deepEqual(localizedCatalog.structuredContent, localizedCatalog.details);
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(await readFile(preferencePath, "utf8"), preference);
    assert.equal(await readFile(join(testWorkspace.cwd, "中文-path.txt"), "utf8"), "original text\n");
  } finally { dispose(app.session); }
});

test("large checkpoint catalogs export their complete history without creating another checkpoint", { timeout: 60000 }, async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    for (let round = 0; round < 260; round++) await app.session.prompt(`Round ${round}.`);
    const entries = app.manager.getEntries();
    const result = await app.checkpoints();
    assert.equal(result.isError, false);
    const details = result.details as any;
    assert.equal(details.output.truncated, true);
    assert.equal(details.output.totalCheckpoints, 260);
    assert.equal(details.checkpoints, undefined);
    assert.ok(!details.output.fullOutputPath.startsWith(testWorkspace.cwd));
    const full = JSON.parse(await readFile(details.output.fullOutputPath, "utf8"));
    assert.equal(full.checkpoints.length, 260);
    assert.equal(full.current.snapshot.id, full.checkpoints[259].id);
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.ok(Buffer.byteLength(text) < 53 * 1024);
    assert.equal(Check(app.session.extensionRunner.getToolDefinition("session_checkpoints")!.outputSchema!, result.structuredContent), true);
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
});
