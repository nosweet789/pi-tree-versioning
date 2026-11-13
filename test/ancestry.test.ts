import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("native navigation and branch summaries resolve only the landed node's ancestry", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace, undefined, { extensionFactories: [pi => {
    pi.on("session_before_tree", () => ({ summary: { summary: "Summary of abandoned work." } }));
  }] });
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Round complete." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "common round\n");
    await app.session.prompt("Common round.");
    const common = ((await app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "abandoned round\n");
    await writeFile(join(testWorkspace.cwd, "abandoned.txt"), "only this branch\n");
    await app.session.prompt("Abandoned round.");
    const abandoned = ((await app.checkpoints()).details as any).checkpoints[1];
    await app.session.navigateTree(common.nodeId, { summarize: true });
    const landing = app.manager.getLeafEntry()!;
    assert.equal(landing.type, "branch_summary");
    assert.equal(landing.parentId, common.nodeId);
    assert.equal(((await app.checkpoints()).details as any).current.snapshot.id, common.id);
    const saved = (await app.diff({ scope: "session" })).details as any;
    assert.equal(saved.to.id, common.id);
    assert.deepEqual(saved.files.map((file: any) => file.path), ["notes.txt"]);
    assert.match(saved.files[0].patch, /\+common round/);
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "abandoned round\n");
    assert.deepEqual(((await app.diff()).details as any).files.map((file: any) => file.path), ["abandoned.txt", "notes.txt"]);

    await rm(join(testWorkspace.cwd, "abandoned.txt"));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "alternate round\n");
    await app.session.prompt("Alternate round.");
    const catalog = (await app.checkpoints()).details as any;
    assert.equal(catalog.checkpoints.length, 3);
    const alternate = catalog.checkpoints[2];
    const round = (await app.diff({ scope: "turn" })).details as any;
    assert.equal(round.from.id, common.id);
    assert.equal(round.to.id, alternate.id);
    assert.match(round.files[0].patch, /-common round\n\+alternate round/);
    const oldRound = (await app.diff({ scope: "turn", checkpointId: abandoned.id })).details as any;
    assert.equal(oldRound.from.id, common.id);
    assert.equal(oldRound.to.id, abandoned.id);
    const userNode = app.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Alternate round"))!;
    await app.session.navigateTree(userNode.id, { summarize: false });
    assert.equal(app.manager.getLeafId(), userNode.parentId);
    const current = ((await app.checkpoints()).details as any).current;
    assert.equal(current.nodeId, userNode.parentId);
    assert.equal(current.snapshot.id, common.id);
    assert.equal((await app.diff({ scope: "session" })).isError, false);
    assert.equal(app.manager.getLeafId(), current.nodeId);
  } finally { dispose(app.session); }
});

test("an applicable baseline is the empty saved-session endpoint before any round exists", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "not yet saved\n");
    const catalog = (await app.checkpoints()).details as any;
    assert.deepEqual(catalog.checkpoints, []);
    assert.equal(catalog.current.snapshot.kind, "baseline");
    const total = (await app.diff({ scope: "session" })).details as any;
    assert.equal(total.from.kind, "baseline");
    assert.deepEqual(total.from, total.to);
    assert.deepEqual(total.files, []);
    assert.equal(((await app.diff({ scope: "turn" })).details as any).code, "no_checkpoint");
    assert.equal(((await app.diff({ scope: "turn", checkpointId: "unknown" })).details as any).code, "no_checkpoint");
    assert.equal(((await app.diff({ checkpointId: "unknown" })).details as any).code, "invalid_request");
  } finally { dispose(app.session); }
});

test("late activation never substitutes a later baseline or another branch's checkpoint for uncovered history", async () => {
  const testWorkspace = await fixture();
  const manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.root, "sessions"));
  const oldUser = manager.appendMessage({ role: "user", content: "Uncovered earlier work.", timestamp: Date.now() });
  manager.appendThinkingLevelChange("off");
  const app = await load(testWorkspace, manager);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "recorded later\n");
    await app.session.prompt("Covered work.");
    await app.session.navigateTree(oldUser, { summarize: false });
    const catalog = (await app.checkpoints()).details as any;
    assert.equal(catalog.checkpoints.length, 1);
    assert.equal(catalog.current.snapshot, null);
    for (const scope of ["workspace", "session"]) {
      const result = await app.diff({ scope });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).code, "no_baseline");
    }
    assert.equal(((await app.diff({ scope: "turn" })).details as any).code, "no_checkpoint");
    assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "recorded later\n");
  } finally { dispose(app.session); }
});
