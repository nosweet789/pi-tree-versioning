import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("startup explains native navigation's overwrite policy in the selected language without restoring files", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      await app.command(locale);
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit remains\n");
      app.notices.length = 0;
      await app.session.reload();
      assert.ok(app.notices.some(notice => locale === "en"
        ? /\/tree.*overwrites.*without.*backup/.test(notice.message)
        : /\/tree.*覆盖.*不.*备份/.test(notice.message)));
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit remains\n");
    }
  } finally { dispose(app.session); }
});

test("native tool-result and user-message destinations restore only their actual ancestry", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "notes.txt"), "pre-session edit\n");
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "common checkpoint\n");
    await app.session.prompt("Common round.");
    const common = ((await app.checkpoints()).details as any).checkpoints[0];
    let requests = 0;
    await useModel(app, () => responseStream(++requests === 1 ? {
      content: [{ type: "toolCall", id: "write-notes", name: "write", arguments: { path: "notes.txt", content: "tool-written state\n" } }], stopReason: "toolUse",
    } : { content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Round with a tool.");
    const toolNode = app.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult")!;
    const catalog = (await app.checkpoints()).details as any;
    await app.command("zh-CN");
    await app.session.navigateTree(toolNode.id, { summarize: false });
    assert.equal(app.manager.getLeafId(), toolNode.id);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "common checkpoint\n");
    assert.match(app.notices.at(-1)!.message, /最近前置检查点/);
    assert.ok(app.notices.at(-1)!.message.includes(common.id));
    await app.session.navigateTree(catalog.checkpoints[1].nodeId, { summarize: false });
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "tool-written state\n");
    assert.match(app.notices.at(-1)!.message, /已恢复检查点/);
    const firstUser = app.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
    const result = await app.session.navigateTree(firstUser.id, { summarize: false });
    assert.equal(result.editorText, "Common round.");
    assert.equal(app.manager.getLeafId(), firstUser.parentId);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "pre-session edit\n");
    assert.match(app.notices.at(-1)!.message, /已恢复适用基线/);
    assert.ok(app.notices.at(-1)!.message.includes(catalog.baseline.id));
  } finally { dispose(app.session); }
});

test("cancelled, failed, and no-op native navigation never restores unsnapshotted files", async () => {
  const workspace = await fixture();
  let cancel = false;
  const app = await load(workspace, undefined, { extensionFactories: [pi => {
    pi.on("session_before_tree", () => cancel ? { cancel: true } : undefined);
  }] });
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("First round.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await app.session.prompt("Second round.");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
    const leaf = app.manager.getLeafId()!;
    const notices = [...app.notices];
    await app.session.navigateTree(leaf, { summarize: false });
    await assert.rejects(app.session.navigateTree("nonexistent", { summarize: false }), /not found/);
    cancel = true;
    assert.equal((await app.session.navigateTree(target.nodeId, { summarize: false })).cancelled, true);
    cancel = false;
    app.session.agent.streamFunction = () => responseStream({ content: [], stopReason: "error", errorMessage: "Simulated summary failure" });
    await assert.rejects(app.session.navigateTree(target.nodeId, { summarize: true }), /Simulated summary failure/);
    app.session.agent.streamFunction = () => {
      app.session.abortBranchSummary();
      return responseStream({ content: [], stopReason: "aborted" });
    };
    const aborted = await app.session.navigateTree(target.nodeId, { summarize: true });
    assert.equal(aborted.cancelled, true);
    assert.equal(aborted.aborted, true);
    assert.equal(app.manager.getLeafId(), leaf);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
    assert.deepEqual(app.notices, notices);

    // Selecting a user message whose parent is already current also has no movement.
    const user = app.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
    await app.session.navigateTree(user.id, { summarize: false });
    await writeFile(join(workspace.cwd, "notes.txt"), "another manual edit\n");
    const noticesAfterMove = [...app.notices];
    await app.session.navigateTree(user.id, { summarize: false });
    assert.equal(app.manager.getLeafId(), user.parentId);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "another manual edit\n");
    assert.deepEqual(app.notices, noticesAfterMove);
  } finally { dispose(app.session); }
});

test("reopening and reloading leave disk alone but subsequent native navigation restores saved files", async () => {
  const workspace = await fixture();
  const original = await load(workspace);
  await useModel(original, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await original.session.prompt("Save initial files.");
  const target = ((await original.checkpoints()).details as any).checkpoints[0];
  await writeFile(join(workspace.cwd, "notes.txt"), "manual edit survives startup\n");
  const sessionFile = original.manager.getSessionFile()!;
  dispose(original.session);
  const app = await load(workspace, SessionManager.open(sessionFile));
  try {
    await app.session.reload();
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit survives startup\n");
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
    assert.equal(app.manager.getLeafId(), target.nodeId);
  } finally { dispose(app.session); }
});
