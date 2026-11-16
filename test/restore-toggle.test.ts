import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { loadRuntime } from "./runtime-fixture.ts";

test("disabling restoration preserves disk during tree navigation while checkpoints and all diff scopes remain active", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "first saved state\n");
    await app.session.prompt("First round.");
    await writeFile(join(workspace.cwd, "notes.txt"), "second saved state\n");
    await app.session.prompt("Second round.");
    const [first, second] = ((await app.checkpoints()).details as any).checkpoints;
    await app.session.prompt("/tree-versioning-restore off");
    await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
    await writeFile(join(workspace.cwd, "new.txt"), "keep this file\n");
    const notices = app.notices.length;
    await app.session.navigateTree(first.nodeId, { summarize: false });
    assert.equal(app.manager.getLeafId(), first.nodeId);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
    assert.equal(await readFile(join(workspace.cwd, "new.txt"), "utf8"), "keep this file\n");
    assert.ok(!app.notices.slice(notices).some(notice => /Restored/.test(notice.message)));
    assert.equal(((await app.checkpoints()).details as any).current.snapshot.id, first.id);
    const unsaved = (await app.diff()).details as any;
    assert.match(unsaved.files.find((file: any) => file.path === "notes.txt").patch, /-first saved state\n\+manual edit/);
    for (const scope of ["turn", "session"]) {
      const comparison = (await app.diff({ scope })).details as any;
      assert.match(comparison.files[0].patch, /-committed\n\+first saved state/);
    }
    await app.session.prompt("Record the unchanged disk after navigation.");
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 3);
    assert.deepEqual(((await app.diff()).details as any).files, []);
    await app.session.prompt("/tree-versioning-restore on");
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
    await app.session.navigateTree(second.nodeId, { summarize: false });
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "second saved state\n");
    await assert.rejects(stat(join(workspace.cwd, "new.txt")), { code: "ENOENT" });
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});

for (const operation of ["fork", "clone"] as const) {
  test(`disabled restoration keeps native ${operation} snapshot inheritance without changing files`, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace);
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "first saved state\n");
      await host.app.session.prompt("First round.");
      await writeFile(join(workspace.cwd, "notes.txt"), "second saved state\n");
      await host.app.session.prompt("Second round.");
      const source = (await host.app.checkpoints()).details as any;
      const selected = host.app.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
      await host.app.session.prompt("/tree-versioning-restore off");
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
      await writeFile(join(workspace.cwd, "new.txt"), "keep this file\n");
      const target = operation === "fork" ? selected.id : host.app.manager.getLeafId()!;
      const result = await host.runtime.fork(target, { position: operation === "fork" ? "before" : "at" });
      assert.equal(result.cancelled, false);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
      assert.equal(await readFile(join(workspace.cwd, "new.txt"), "utf8"), "keep this file\n");
      assert.ok(host.app.notices.some(notice => /File restoration is off/.test(notice.message)));
      assert.ok(!host.app.notices.some(notice => /Restored/.test(notice.message)));
      const child = (await host.app.checkpoints()).details as any;
      assert.notEqual(child.sessionId, source.sessionId);
      assert.equal(child.baseline.id, source.baseline.id);
      const expected = operation === "fork" ? [source.checkpoints[0]] : source.checkpoints;
      assert.deepEqual(child.checkpoints.map((checkpoint: any) => checkpoint.id), expected.map((checkpoint: any) => checkpoint.id));
      for (const scope of ["workspace", "turn", "session"]) {
        assert.equal((await host.app.diff({ scope })).isError, false, scope);
      }
      await host.app.session.prompt("/tree-versioning-restore on");
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
      assert.deepEqual(host.app.errors, []);
    } finally { await host.runtime.dispose(); }
  });
}
