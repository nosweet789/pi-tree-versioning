import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("an early Git exit during a large restore input reports failure without terminating the host", { timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--import", "./test/isolate.mjs", "--import", "tsx", "test/restore-pipe-worker.ts"], { timeout: 25000 });
  assert.match(stdout, /Restore failure reported; host still running/);
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`${locale} reports partial restoration after an injected filesystem write failure without undoing native navigation`, async t => {
    const workspace = await fixture();
    await writeFile(join(workspace.cwd, "a.txt"), "saved first\n");
    await writeFile(join(workspace.cwd, "z.txt"), "saved last\n");
    const app = await load(workspace);
    try {
      await app.command(locale);
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Record the restore target.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      await writeFile(join(workspace.cwd, "a.txt"), "changed first\n");
      await writeFile(join(workspace.cwd, "z.txt"), "changed last\n");
      const write = fs.writeFileSync;
      let failedWrite = false;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === join(workspace.cwd, "z.txt")) {
          failedWrite = true;
          throw Object.assign(new Error("Simulated disk write failure"), { code: "EIO" });
        }
        return write(...args);
      });
      syncBuiltinESMExports();
      await app.session.navigateTree(target.nodeId, { summarize: false });
      assert.equal(failedWrite, true, "The filesystem fault must actually be injected");
      assert.equal(app.manager.getLeafId(), target.nodeId);
      assert.equal(await readFile(join(workspace.cwd, "a.txt"), "utf8"), "saved first\n");
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.match(app.notices.at(-1)!.message, locale === "en" ? /may be partially restored/ : /可能处于部分恢复状态/);
      assert.doesNotMatch(app.notices.at(-1)!.message, /Restored checkpoint|已恢复检查点/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); dispose(app.session); }
  });

  test(`${locale} explains uncovered history without restoring a late-activation baseline`, async () => {
    const workspace = await fixture();
    const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
    const oldUser = manager.appendMessage({ role: "user", content: "Uncovered work", timestamp: Date.now() });
    manager.appendThinkingLevelChange("off");
    const app = await load(workspace, manager);
    try {
      await app.command(locale);
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
      await app.session.navigateTree(oldUser, { summarize: false });
      assert.equal(app.manager.getLeafId(), null);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.match(app.notices.at(-1)!.message, locale === "en" ? /No usable file history/ : /没有可用文件历史/);
    } finally { dispose(app.session); }
  });
}

for (const mode of ["print", "json"] as const) {
  test(`${mode} exposes missing-history restoration errors without injecting model messages`, async () => {
    const workspace = await fixture();
    const app = await load(workspace, undefined, { mode });
    try {
      await app.command(mode === "json" ? "zh-CN" : "en");
      const storage = join(workspace.agentDir, "tree-versioning", app.manager.getSessionId());
      const previous = new Set(await readdir(storage));
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Record history.");
      const target = ((await app.checkpoints()).details as any).checkpoints[0];
      for (const name of (await readdir(storage)).filter(name => !previous.has(name))) await rm(join(storage, name));
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
      const entries = app.manager.getEntries();
      await app.session.navigateTree(target.nodeId, { summarize: false });
      assert.equal(app.manager.getLeafId(), target.nodeId);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
      assert.deepEqual(app.manager.getEntries(), entries);
      assert.equal(app.errors.length, 1);
      assert.match(app.errors[0], mode === "print" ? /No usable file history/ : /没有可用文件历史/);
      assert.deepEqual(app.notices, []);
    } finally { dispose(app.session); }
  });
}
