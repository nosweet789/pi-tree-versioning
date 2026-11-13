import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

for (const rename of [false, true]) {
  test(`collection ${rename ? "overlapping a rename" : "without a rename"} retains the original settled-node association`, { timeout: 10000 }, async () => {
    const testWorkspace = await fixture();
    const app = await load(testWorkspace);
    const originalPath = process.env.PATH;
    const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const commands = join(testWorkspace.root, "commands");
    const started = join(testWorkspace.root, "collection-started");
    const released = join(testWorkspace.root, "collection-released");
    let running: Promise<void> | undefined;
    try {
      await mkdir(commands);
      await writeFile(join(commands, "git"), `#!${process.execPath}
  const { existsSync, writeFileSync } = require("node:fs");
  const { spawnSync } = require("node:child_process");
  if (process.argv.includes("ls-files")) {
    writeFileSync(${JSON.stringify(started)}, "ready");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(released)})) Atomics.wait(pause, 0, 0, 10);
  }
  const result = spawnSync(${JSON.stringify(gitExecutable)}, process.argv.slice(2), { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
  `, { mode: 0o700 });
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(testWorkspace.cwd, "notes.txt"), "settled round\n");
      process.env.PATH = commands + ":" + originalPath;
      running = app.session.prompt("A round overlapping a rename.");
      const signal = AbortSignal.timeout(3000);
      while (!existsSync(started)) await delay(5, undefined, { signal });
      const stoppedNodeId = app.manager.getLeafId();
      const sessionId = app.manager.getSessionId();
      if (rename) {
        app.session.setSessionName("Renamed during collection");
        assert.notEqual(app.manager.getLeafId(), stoppedNodeId);
      }
      assert.equal(app.manager.getSessionId(), sessionId);
      await writeFile(released, "continue");
      await running;
      process.env.PATH = originalPath;
      const catalog = (await app.checkpoints()).details as any;
      assert.equal(catalog.checkpoints.length, 1, JSON.stringify(app.notices));
      assert.equal(catalog.checkpoints[0].nodeId, stoppedNodeId);
      assert.equal(catalog.current.snapshot.id, catalog.checkpoints[0].id);
      assert.match(((await app.diff({ scope: "turn" })).details as any).files[0].patch, /\+settled round/);
      await app.session.reload();
      assert.deepEqual((await app.checkpoints()).details, catalog);
    } finally {
      await writeFile(released, "continue");
      await running;
      process.env.PATH = originalPath;
      dispose(app.session);
    }
  });
}
