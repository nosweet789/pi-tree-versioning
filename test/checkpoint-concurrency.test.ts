import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { pauseGitScan } from "./git-gate.ts";

for (const rename of [false, true]) {
  test(`collection ${rename ? "overlapping a rename" : "without a rename"} retains the original settled-node association`, { timeout: 10000 }, async () => {
    const testWorkspace = await fixture();
    const app = await load(testWorkspace);
    let gate: Awaited<ReturnType<typeof pauseGitScan>> | undefined;
    let running: Promise<void> | undefined;
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(testWorkspace.cwd, "notes.txt"), "settled round\n");
      gate = await pauseGitScan(testWorkspace);
      running = app.session.prompt("A round overlapping a rename.");
      await gate.wait();
      const stoppedNodeId = app.manager.getLeafId();
      const sessionId = app.manager.getSessionId();
      if (rename) {
        app.session.setSessionName("Renamed during collection");
        assert.notEqual(app.manager.getLeafId(), stoppedNodeId);
      }
      assert.equal(app.manager.getSessionId(), sessionId);
      await gate.release();
      gate = undefined;
      await running;
      const catalog = (await app.checkpoints()).details as any;
      assert.equal(catalog.checkpoints.length, 1, JSON.stringify(app.notices));
      assert.equal(catalog.checkpoints[0].nodeId, stoppedNodeId);
      assert.equal(catalog.current.snapshot.id, catalog.checkpoints[0].id);
      assert.match(((await app.diff({ scope: "turn" })).details as any).files[0].patch, /\+settled round/);
      await app.session.reload();
      assert.deepEqual((await app.checkpoints()).details, catalog);
    } finally {
      try {
        await gate?.release();
        await running;
      } finally { dispose(app.session); }
    }
  });
}
