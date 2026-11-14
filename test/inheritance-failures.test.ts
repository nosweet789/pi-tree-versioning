import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { damageCheckpoint, failWorkspaceWrite } from "./fault-fixture.ts";

for (const failure of ["cancel", "invalid-entry", "missing-source"] as const) {
  test(`native fork ${failure} never restores files or leaks its restore intent into a later clone`, async () => {
    const workspace = await fixture();
    let cancel = false;
    const host = await loadRuntime(workspace, undefined, { extensionFactories: [pi => {
      pi.on("session_before_fork", () => cancel ? { cancel: true } : undefined);
    }] });
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await host.app.session.prompt("Save a conversation.");
      const user = host.app.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
      const original = host.app.session;
      const entries = host.app.manager.getEntries();
      const sourceFile = host.app.manager.getSessionFile()!;
      const sourceText = await readFile(sourceFile);
      await writeFile(join(workspace.cwd, "notes.txt"), "cancelled work stays\n");
      if (failure === "cancel") {
        cancel = true;
        assert.equal((await host.runtime.fork(user.id)).cancelled, true);
        cancel = false;
      } else {
        if (failure === "missing-source") await rm(sourceFile);
        await assert.rejects(host.runtime.fork(failure === "invalid-entry" ? "missing-entry" : user.id));
        if (failure === "missing-source") await writeFile(sourceFile, sourceText);
      }
      assert.equal(host.app.session, original);
      assert.deepEqual(host.app.manager.getEntries(), entries);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "cancelled work stays\n");
      await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
      assert.equal((await host.app.checkpoints()).isError, false);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "cancelled work stays\n");
    } finally { await host.runtime.dispose(); }
  });
}

for (const locale of ["en", "zh-CN"] as const) for (const mode of ["rpc", "print", "json"] as const) {
  test(`${locale} ${mode} reports a partially restored successful fork without undoing its native session`, async t => {
    const workspace = await fixture();
    await writeFile(join(workspace.cwd, "a.txt"), "saved first\n");
    await writeFile(join(workspace.cwd, "z.txt"), "saved last\n");
    const host = await loadRuntime(workspace, undefined, { mode }, { expectedStartupErrors: mode === "rpc" ? 0 : 1 });
    try {
      await host.app.command(locale);
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await host.app.session.prompt("Save the restore target.");
      const sourceId = host.app.manager.getSessionId();
      const destination = host.app.manager.getLeafId();
      await host.app.session.prompt("Fork before this request.");
      const selected = host.app.manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
      await writeFile(join(workspace.cwd, "a.txt"), "changed first\n");
      await writeFile(join(workspace.cwd, "z.txt"), "changed last\n");
      const injected = failWorkspaceWrite(t, join(workspace.cwd, "z.txt"));
      assert.equal((await host.runtime.fork(selected.id)).cancelled, false);
      assert.equal(injected(), true, "The filesystem fault must actually be injected");
      assert.notEqual(host.app.manager.getSessionId(), sourceId);
      assert.equal(host.app.manager.getLeafId(), destination);
      assert.equal(await readFile(join(workspace.cwd, "a.txt"), "utf8"), "saved first\n");
      const failure = mode === "rpc" ? host.app.notices.at(-1)!.message : host.app.errors.at(-1)!;
      assert.match(failure, locale === "en" ? /may be partially restored/ : /可能处于部分恢复状态/);
      assert.doesNotMatch(failure, /no files were restored|未恢复文件/);
      assert.equal((await host.app.checkpoints()).isError, false, "Restoration failure must not discard inherited history");
    } finally { await host.runtime.dispose(); }
  });
}


test("a copy publication failure exposes no partial child history and never changes the workspace", async () => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace, undefined, {}, { beforeLoad: async manager => {
    const storage = join(workspace.agentDir, "tree-versioning", manager.getSessionId());
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, "existing-data"), "must not be replaced");
  } });
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await host.app.session.prompt("First checkpoint.");
    await host.app.session.prompt("Second checkpoint.");
    const sourceId = host.app.manager.getSessionId();

    await writeFile(join(workspace.cwd, "notes.txt"), "copy failure keeps disk\n");
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    assert.equal(await readFile(join(workspace.agentDir, "tree-versioning", host.app.manager.getSessionId(), "existing-data"), "utf8"), "must not be replaced");
    assert.notEqual(host.app.manager.getSessionId(), sourceId);
    assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
    assert.equal((await host.app.checkpoints()).isError, true);
    assert.match(host.app.notices.at(-1)!.message, /inheritance.*no files were restored/);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "copy failure keeps disk\n");
  } finally { await host.runtime.dispose(); }
});

for (const fault of ["missing", "corrupt"] as const) for (const operation of ["fork", "clone"] as const) {
  test(`${operation} with a ${fault} source checkpoint reports unavailable inheritance without changing files`, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace);
    try {
      const locale = fault === "missing" ? "en" : "zh-CN";
      await host.app.command(locale);
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await host.app.session.prompt("Save a checkpoint.");
      const checkpoint = ((await host.app.checkpoints()).details as any).checkpoints[0];
      const sourceId = host.app.manager.getSessionId();
      await damageCheckpoint(workspace, sourceId, checkpoint.id, fault);
      const nextUser = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "files remain untouched\n");
      await host.runtime.fork(operation === "fork" ? nextUser : host.app.manager.getLeafId()!,
        { position: operation === "fork" ? "before" : "at" });
      assert.notEqual(host.app.manager.getSessionId(), sourceId);
      assert.equal(host.app.manager.getLeafId(), host.app.startupLeaf);
      assert.equal((await host.app.checkpoints()).isError, true);
      assert.match(host.app.notices.at(-1)!.message, locale === "en" ? /inheritance.*no files were restored/ : /无法安全完成.*未恢复文件/);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "files remain untouched\n");
      await host.app.session.reload();
      assert.equal((await host.app.diff()).isError, true);
    } finally { await host.runtime.dispose(); }
  });
}

for (const persistent of [true, false]) {
  test(`${persistent ? "persistent" : "ephemeral"} reload recovers an interrupted inheritance without retrying fork restoration`, async () => {
    const workspace = await fixture();
    const storage = join(workspace.agentDir, "tree-versioning");
    const host = await loadRuntime(workspace, persistent ? undefined : SessionManager.inMemory(workspace.cwd), {}, {
      beforeLoad: async () => {
        await rename(storage, storage + "-offline");
        await writeFile(storage, "temporary mount obstruction");
      },
    });
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "saved before interruption\n");
      await host.app.session.prompt("Save the inherited target.");
      const source = (await host.app.checkpoints()).details as any;
      const selected = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edits survive reload\n");
      await host.runtime.fork(selected);
      assert.equal((await host.app.checkpoints()).isError, true);
      await rm(storage);
      await rename(storage + "-offline", storage);
      await host.app.session.reload();
      const recovered = await host.app.checkpoints();
      assert.equal(recovered.isError, false, JSON.stringify(recovered.details));
      const catalog = recovered.details as any;
      assert.equal(catalog.baseline.id, source.baseline.id);
      assert.equal(catalog.current.snapshot.id, source.checkpoints[0].id);
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edits survive reload\n");
    } finally { await host.runtime.dispose(); }
  });
}

for (const obstruction of ["child-directory", "storage-root"] as const) {
  test(`an early ${obstruction} obstruction cannot reset an empty fork to disk state after reload`, async () => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  const first = manager.appendMessage({ role: "user", content: "Old initial message", timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "Later activation", timestamp: Date.now() });
  let blocker: string;
  const host = await loadRuntime(workspace, manager, {}, { beforeLoad: async child => {
    const storage = join(workspace.agentDir, "tree-versioning");
    blocker = obstruction === "child-directory" ? join(storage, child.getSessionId()) : storage;
    if (obstruction === "storage-root") await rename(storage, storage + "-offline");
    await writeFile(blocker, "temporary storage obstruction");
  } });
  try {
    const baseline = ((await host.app.checkpoints()).details as any).baseline;
    await writeFile(join(workspace.cwd, "notes.txt"), "never recorded history\n");
    await host.runtime.fork(first);
    assert.equal((await host.app.checkpoints()).isError, true);
    await rm(blocker!);
    if (obstruction === "storage-root") await rename(blocker! + "-offline", blocker!);
    await host.app.session.reload();
    const catalog = await host.app.checkpoints();
    assert.ok(catalog.isError || (catalog.details as any).baseline.id === baseline.id,
      "Reload may recover inherited history or report it unavailable, but never redefine the baseline");
    assert.equal((await host.app.diff()).isError, true);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "never recorded history\n");
  } finally { await host.runtime.dispose(); }
});

}

test("failed inheritance at an empty fork never becomes a fresh baseline on reload", async () => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  const firstUser = manager.appendMessage({ role: "user", content: "Uncovered old request", timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "Later activation", timestamp: Date.now() });
  const host = await loadRuntime(workspace, manager);
  try {
    await rm(join(workspace.agentDir, "tree-versioning", manager.getSessionId()), { recursive: true });
    await writeFile(join(workspace.cwd, "notes.txt"), "must not become the inherited baseline\n");
    assert.equal((await host.runtime.fork(firstUser)).cancelled, false);
    const destination = host.app.startupLeaf;
    assert.equal(host.app.manager.getLeafId(), destination);
    assert.equal((await host.app.diff()).isError, true);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "must not become the inherited baseline\n");
    await host.app.session.reload();
    assert.equal((await host.app.diff()).isError, true, "Reload must not redefine a failed fork's origin from disk");
    assert.equal(host.app.manager.getLeafId(), destination);
  } finally { await host.runtime.dispose(); }
});
