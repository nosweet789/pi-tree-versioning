import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, load } from "./harness.ts";

for (const target of ["root", "earlier-node"] as const) {
  test(`late activation at ${target} does not cover descendants that already existed`, async () => {
    const testWorkspace = await fixture();
    const manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.root, "sessions"));
    const firstUser = manager.appendMessage({ role: "user", content: "First", timestamp: Date.now() });
    const earlierNode = manager.appendThinkingLevelChange("off");
    manager.appendMessage({ role: "user", content: "Later", timestamp: Date.now() });
    manager.appendThinkingLevelChange("off");
    const pipe = join(testWorkspace.cwd, "notes.txt");
    await rm(pipe);
    execFileSync("mkfifo", [pipe]);
    const app = await load(testWorkspace, manager);
    try {
      const oldLeaf = manager.getLeafId()!;
      await app.session.navigateTree(target === "root" ? firstUser : earlierNode, { summarize: false });
      await rm(pipe);
      await writeFile(pipe, "first readable state\n");
      await app.session.reload();
      assert.equal((await app.diff()).isError, false);
      const recordedPosition = manager.getLeafId()!;
      await app.session.navigateTree(oldLeaf, { summarize: false });
      assert.equal(manager.getLeafId(), oldLeaf);
      const unavailable = await app.diff();
      assert.equal(unavailable.isError, true);
      assert.equal((unavailable.details as any).code, "no_baseline");
      await app.session.navigateTree(recordedPosition, { summarize: false });
      assert.equal((await app.diff()).isError, false);
    } finally { dispose(app.session); }
  });
}

test("first activation in an old session covers only the activation position and its descendants", async () => {
  const testWorkspace = await fixture();
  const manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.root, "sessions"));
  const early = manager.appendMessage({ role: "user", content: "Earlier work", timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "Current work", timestamp: Date.now() });
  await writeFile(join(testWorkspace.cwd, "notes.txt"), "state at activation\n");
  const app = await load(testWorkspace, manager);
  try {
    const initial = (await app.diff()).details as any;
    assert.equal(initial.from.anchorId, app.startupLeaf);
    assert.deepEqual(initial.files, []);
    const baselineEntry = manager.getLeafId()!;
    await app.session.navigateTree(early, { summarize: false });
    const leaf = manager.getLeafId();
    const missing = await app.diff();
    assert.equal(missing.isError, true);
    assert.equal((missing.details as any).code, "no_baseline");
    assert.equal(manager.getLeafId(), leaf);
    await app.session.reload();
    assert.equal((await app.diff()).isError, true);
    await app.session.navigateTree(baselineEntry, { summarize: false });
    assert.deepEqual((await app.diff()).details, initial);
  } finally { dispose(app.session); }
});
