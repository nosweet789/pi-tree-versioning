import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { responseStream, useModel, type TestApp } from "./agent-fixture.ts";
import { dispose, fixture, load } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";

initTheme("dark", false);

function mountCard(app: TestApp, entry: CustomEntry) {
  const renderer = app.session.extensionRunner.getEntryRenderer(entry.customType);
  assert.ok(renderer);
  const component = new CustomEntryComponent(entry, renderer);
  component.setExpanded(true);
  return () => component.render(120).map(stripVTControlCharacters).join("\n");
}

for (const operation of ["fork", "clone"] as const) {
  test(`a ${operation} child's historical card rerenders in both languages after source removal and reopening`, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace, undefined, { extensionFactories: [pi => {
      pi.on("turn_end", (_event, ctx) => pi.setLabel(ctx.sessionManager.getLeafId()!, "saved round"));
    }] });
    let reopened: TestApp | undefined;
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "中文-code.ts"), "const greeting = '原始 English';\n");
      await host.app.session.prompt("Record the source card.");
      const sourceId = host.app.manager.getSessionId();
      const sourceFile = host.app.manager.getSessionFile()!;
      const sourceCard = host.app.manager.getEntries().find((entry): entry is CustomEntry =>
        entry.type === "custom" && entry.customType === "tree-versioning.checkpoint")!;
      const selected = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "unsnapshotted edit\n");
      await host.runtime.fork(selected, { position: operation === "fork" ? "before" : "at" });
      const childFile = host.app.manager.getSessionFile()!;
      const childCard = host.app.manager.getEntries().find((entry): entry is CustomEntry => entry.id === sourceCard.id)!;
      assert.deepEqual(childCard.data, sourceCard.data);
      const entries = host.app.manager.getEntries();
      const comparison = (await host.app.diff({ scope: "turn" })).details;
      const catalog = (await host.app.checkpoints()).details;
      const context = host.app.manager.buildSessionContext().messages;
      const render = mountCard(host.app, childCard);
      assert.match(render(), /Round diff/);
      assert.match(render(), /中文-code.ts/);
      assert.match(render(), /const greeting = '原始 English';/);
      await host.app.command("zh-CN");
      assert.match(render(), /轮次差异/);
      assert.deepEqual((await host.app.diff({ scope: "turn" })).details, comparison);
      assert.deepEqual((await host.app.checkpoints()).details, catalog);
      assert.deepEqual(host.app.manager.getEntries(), entries);
      assert.deepEqual(host.app.manager.buildSessionContext().messages, context);
      assert.ok(!JSON.stringify(context).includes("const greeting"), "Automatic cards must remain outside model context");
      await host.runtime.dispose();
      await rm(sourceFile);
      await rm(join(workspace.agentDir, "tree-versioning", sourceId), { recursive: true });
      await writeFile(join(workspace.cwd, "notes.txt"), "do not restore on reopen\n");
      reopened = await load(workspace, SessionManager.open(childFile));
      const renderReopened = mountCard(reopened, childCard);
      assert.match(renderReopened(), /轮次差异/);
      await reopened.command("en");
      assert.match(renderReopened(), /Round diff/);
      assert.match(renderReopened(), /const greeting = '原始 English';/);
      assert.deepEqual((await reopened.diff({ scope: "turn" })).details, comparison);
      assert.deepEqual((await reopened.checkpoints()).details, catalog);
      assert.deepEqual(reopened.manager.getEntries(), entries);
      assert.deepEqual(reopened.manager.buildSessionContext().messages, context);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "do not restore on reopen\n");
    } finally {
      await host.runtime.dispose();
      if (reopened) dispose(reopened.session);
    }
  });
}
