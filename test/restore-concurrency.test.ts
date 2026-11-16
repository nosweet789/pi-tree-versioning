import assert from "node:assert/strict";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load, type Fixture } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { pauseGitScan } from "./git-gate.ts";
import { loadRuntime } from "./runtime-fixture.ts";

async function pausePreferenceWrites(workspace: Fixture) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const finished = withFileMutationQueue(join(workspace.agentDir, "tree-versioning", "preferences.json"), async () => {
    entered();
    await held;
  });
  await Promise.race([locked, finished]);
  return { release, finished };
}

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

test("restoration is suspended while a switch command is waiting to persist", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  let gate: Awaited<ReturnType<typeof pausePreferenceWrites>> | undefined;
  let command: Promise<unknown> | undefined;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Record a target.");
    const target = ((await app.checkpoints()).details as any).checkpoints[0];
    await app.session.prompt("/tree-versioning-restore on");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
    gate = await pausePreferenceWrites(workspace);
    command = app.session.prompt("/tree-versioning-restore off");
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
    await app.session.navigateTree(target.nodeId, { summarize: false });
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
    gate.release();
    await command;
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
  } finally {
    gate?.release();
    await gate?.finished;
    await command;
    dispose(app.session);
  }
});

for (const operation of ["fork", "reload"] as const) {
  test(`a pending off command remains effective across ${operation} runtime replacement`, { timeout: 15000 }, async () => {
    const workspace = await fixture();
    let gate: Awaited<ReturnType<typeof pausePreferenceWrites>> | undefined;
    let command: Promise<unknown> | undefined;
    const host = await loadRuntime(workspace, undefined, { extensionFactories: [pi => {
      pi.on("session_start", async event => {
        if (event.reason !== "startup") { gate?.release(); await command; }
      });
    }] });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await host.app.session.prompt("/tree-versioning-restore on");
      const target = host.app.manager.appendMessage({ role: "user", content: "Fork here.", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
      gate = await pausePreferenceWrites(workspace);
      command = host.app.session.prompt("/tree-versioning-restore off");
      // Release after replacement loads stale settings, or after it correctly waits for the save.
      releaseTimer = setTimeout(gate.release, 1000);
      if (operation === "fork") await host.runtime.fork(target);
      else await host.app.session.reload();
      await command;
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
      assert.deepEqual((await host.app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
      assert.deepEqual(host.app.errors, []);
    } finally {
      clearTimeout(releaseTimer);
      gate?.release();
      await gate?.finished;
      await command;
      await host.runtime.dispose();
    }
  });
}

for (const reenable of [false, true]) {
  test(`disabling restoration invalidates a pending restore${reenable ? " even after re-enabling" : ""}`, { timeout: 15000 }, async () => {
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
      await app.session.prompt("/tree-versioning-restore off");
      if (reenable) await app.session.prompt("/tree-versioning-restore on");
      await gate.release();
      await navigation;
      assert.equal(app.manager.getLeafId(), target.nodeId);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
      assert.match(app.notices.at(-1)!.message, /superseded/);
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
