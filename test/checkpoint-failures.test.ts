import assert from "node:assert/strict";
import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("a session moved inside the managed workspace cannot append new checkpoint history", async () => {
  const testWorkspace = await fixture();
  const original = await load(testWorkspace);
  await useModel(original, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await original.session.prompt("Initial round.");
  const before = ((await original.checkpoints()).details as any).checkpoints;
  const insideSession = join(testWorkspace.cwd, "moved-session.jsonl");
  await copyFile(original.manager.getSessionFile()!, insideSession);
  dispose(original.session);
  const app = await load(testWorkspace, SessionManager.open(insideSession));
  try {
    assert.equal(app.notices.at(-1)?.type, "error");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Unsafe checkpoint persistence.");
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, before);
    assert.match(app.notices.at(-1)!.message, /round was not recorded/);
  } finally { dispose(app.session); }
});

test("unchanged rounds have checkpoints but incomplete collection never publishes one", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  const path = join(testWorkspace.cwd, "notes.txt");
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("An unchanged round.");
    const initial = ((await app.checkpoints()).details as any).checkpoints;
    assert.equal(initial.length, 1);
    assert.deepEqual(((await app.diff({ scope: "turn" })).details as any).files, []);
    await rm(path);
    execFileSync("mkfifo", [path]);
    await app.command("zh-CN");
    await app.session.prompt("Collection will fail.");
    assert.match(app.notices.at(-1)!.message, /本轮未记录/);
    assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, initial);
    const failed = await app.diff();
    assert.equal(failed.isError, true);
    assert.equal((failed.details as any).code, "capture_failed");
    await rm(path);
    await writeFile(path, "readable after failure\n");
    await app.session.prompt("A later complete round.");
    const catalog = (await app.checkpoints()).details as any;
    assert.equal(catalog.checkpoints.length, 2);
    const round = (await app.diff({ scope: "turn" })).details as any;
    assert.equal(round.from.id, initial[0].id);
    assert.match(round.files[0].patch, /\+readable after failure/);
  } finally { dispose(app.session); }
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} mode reports capture failure through the host error channel without publishing history`, async () => {
    const testWorkspace = await fixture();
    const app = await load(testWorkspace, undefined, { mode });
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await rm(join(testWorkspace.cwd, "notes.txt"));
      execFileSync("mkfifo", [join(testWorkspace.cwd, "notes.txt")]);
      if (mode === "json") await app.command("zh-CN");
      await app.session.prompt("A round with an unreadable file.");
      assert.equal(app.errors.length, 1);
      assert.match(app.errors[0], mode === "print" ? /This round was not recorded/ : /本轮未记录/);
      assert.deepEqual(((await app.checkpoints()).details as any).checkpoints, []);
      assert.deepEqual(app.notices, []);
    } finally { dispose(app.session); }
  });
}

for (const damage of ["missing", "corrupt", "fifo"] as const) {
  test(`${damage} checkpoint data is an error, not an empty diff or an ancestor fallback`, { timeout: 10000 }, async () => {
    const testWorkspace = await fixture();
    const app = await load(testWorkspace);
    const storage = join(testWorkspace.agentDir, "tree-versioning", app.manager.getSessionId());
    try {
      const before = new Set(await readdir(storage));
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(testWorkspace.cwd, "notes.txt"), "saved checkpoint\n");
      await app.session.prompt("Record a checkpoint.");
      const checkpoints = ((await app.checkpoints()).details as any).checkpoints;
      assert.equal(checkpoints.length, 1);
      for (const name of (await readdir(storage)).filter(name => !before.has(name))) {
        const path = join(storage, name);
        if (damage === "corrupt") await writeFile(path, "{}");
        else {
          await rm(path);
          if (damage === "fifo") execFileSync("mkfifo", [path]);
        }
      }
      await writeFile(join(testWorkspace.cwd, "notes.txt"), "manual edit remains\n");
      const entries = app.manager.getEntries();
      for (const query of [() => app.checkpoints(), ...["workspace", "turn", "session"].map(scope => () => app.diff({ scope }))]) {
        const result = await query();
        assert.equal(result.isError, true);
        assert.equal((result.details as any).code, "snapshot_unavailable");
      }
      await app.session.reload();
      assert.equal((await app.checkpoints()).isError, true);
      assert.deepEqual(app.manager.getEntries(), entries);
      assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "manual edit remains\n");
    } finally { dispose(app.session); }
  });
}
