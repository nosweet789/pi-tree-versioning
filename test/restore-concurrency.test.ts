import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { pauseGitScan } from "./git-gate.ts";

for (const action of ["rename", "reload", "new-round"] as const) {
  test(`a pending restore handles ${action} without overwriting newer work`, { timeout: 15000 }, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    let gate: Awaited<ReturnType<typeof pauseGitScan>> | undefined;
    let navigation: Promise<unknown> | undefined;
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Record a target.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
      gate = await pauseGitScan(workspace);
      navigation = app.session.navigateTree(target.nodeId, { summarize: false });
      await gate.wait();
      if (action === "rename") app.session.setSessionName("Renamed while restoring");
      else if (action === "reload") await app.session.reload();
      else {
        await writeFile(join(workspace.cwd, "notes.txt"), "newer round\n");
        await app.session.prompt("Continue at the navigation destination.");
      }
      const leaf = app.manager.getLeafId();
      await gate.release();
      await navigation;
      assert.equal(app.manager.getLeafId(), leaf);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"),
        action === "rename" ? "committed\n" : action === "reload" ? "manual edit\n" : "newer round\n");
      assert.deepEqual(app.errors, []);
    } finally {
      await gate?.release();
      await navigation;
      dispose(app.session);
    }
  });
}

for (const navigateAgain of [false, true]) {
  test(`a delayed restore ${navigateAgain ? "superseded by another navigation" : "without another navigation"} cannot overwrite a newer destination`, { timeout: 15000 }, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    let gate: Awaited<ReturnType<typeof pauseGitScan>> | undefined;
    let navigation: Promise<unknown> | undefined;
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "first saved state\n");
      await app.session.prompt("First round.");
      await writeFile(join(workspace.cwd, "notes.txt"), "second saved state\n");
      await app.session.prompt("Second round.");
      const [first, second] = ((await app.checkpoints()).details as any).checkpoints;
      gate = await pauseGitScan(workspace);
      navigation = app.session.navigateTree(first.nodeId, { summarize: false });
      await gate.wait();
      if (navigateAgain) {
        await app.session.navigateTree(second.nodeId, { summarize: false });
        assert.equal(app.manager.getLeafId(), second.nodeId);
        assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "second saved state\n");
        assert.ok(app.notices.at(-1)!.message.includes(second.id));
      }
      await gate.release();
      await navigation;
      assert.equal(app.manager.getLeafId(), navigateAgain ? second.nodeId : first.nodeId);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), navigateAgain ? "second saved state\n" : "first saved state\n");
      if (navigateAgain) assert.match(app.notices.at(-1)!.message, /superseded/);
      else assert.match(app.notices.at(-1)!.message, /Restored checkpoint/);
    } finally {
      await gate?.release();
      await navigation;
      dispose(app.session);
    }
  });
}
