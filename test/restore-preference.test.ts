import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";

test("the restore command remembers a global choice across reload and new sessions without replacing the language", async () => {
  const workspace = await fixture();
  const settingsPath = join(workspace.agentDir, "settings.json");
  await writeFile(settingsPath, '{"theme":"dark"}\n');
  const app = await load(workspace);
  try {
    assert.ok(app.session.extensionRunner.getCommand("tree-versioning-restore"));
    const entries = app.manager.getEntries();
    await app.session.prompt("/tree-versioning-restore");
    assert.match(app.notices.at(-1)!.message, /File restoration: on/);
    await app.session.prompt("/tree-versioning-restore off");
    assert.match(app.notices.at(-1)!.message, /File restoration: off/);
    await app.command("zh-CN");
    await app.session.reload();
    await app.session.prompt("/tree-versioning-restore");
    assert.match(app.notices.at(-1)!.message, /文件恢复：关闭/);
    await app.session.prompt("/tree-versioning-restore on");
    assert.match(app.notices.at(-1)!.message, /文件恢复：开启/);
    await app.command("help");
    assert.match(app.notices.at(-1)!.message, /语言偏好：zh-CN/);
    await app.session.prompt("/tree-versioning-restore off");
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"dark"}\n');
  } finally { dispose(app.session); }
  const next = await load(workspace);
  try {
    await next.session.prompt("/tree-versioning-restore");
    assert.match(next.notices.at(-1)!.message, /文件恢复：关闭/);
    await next.command("help");
    assert.match(next.notices.at(-1)!.message, /语言偏好：zh-CN/);
    assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"dark"}\n');
  } finally { dispose(next.session); }
});

test("legacy language-only preferences default restoration to on and status or help does not write settings", async () => {
  const workspace = await fixture();
  const storage = join(workspace.agentDir, "tree-versioning");
  await mkdir(storage);
  const path = join(storage, "preferences.json");
  const original = '{"language":"zh-CN"}\n';
  await writeFile(path, original);
  const app = await load(workspace);
  try {
    const command = app.session.extensionRunner.getCommand("tree-versioning-restore")!;
    assert.deepEqual(await command.getArgumentCompletions!("of"), [{ value: "off", label: "off" }]);
    const [here] = (await command.getArgumentCompletions!("he"))!;
    assert.equal(here.value, "here");
    assert.match(here.description ?? "", /覆盖.*删除/);
    const entries = app.manager.getEntries();
    for (const args of ["", "help", "invalid", "off extra", "here extra"]) {
      await app.session.prompt("/tree-versioning-restore " + args);
      const { message } = app.notices.at(-1)!;
      assert.match(message, /文件恢复：开启/);
      assert.match(message, /on \| off \| here/);
      assert.match(message, /未入快照.*可能被覆盖.*新文件可能被删除/);
    }
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: true });
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(app.manager.getEntries(), entries);
    await app.session.prompt("/tree-versioning-restore off");
    await app.session.reload();
    await app.command("help");
    assert.match(app.notices.at(-1)!.message, /语言偏好：zh-CN/);
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
  } finally { dispose(app.session); }
});

test("concurrent language and restoration commands preserve both choices", async () => {
  const app = await load(await fixture());
  try {
    await Promise.all([
      app.session.prompt("/tree-versioning-restore off"),
      app.command("zh-CN"),
    ]);
    await app.session.reload();
    await app.command("help");
    assert.match(app.notices.at(-1)!.message, /语言偏好：zh-CN/);
    assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
  } finally { dispose(app.session); }
});

test("saving a language in another running workspace does not overwrite the global restoration choice", async () => {
  const workspace = await fixture();
  const otherWorkspace = { ...await fixture(), agentDir: workspace.agentDir };
  const first = await load(workspace);
  const second = await load(otherWorkspace);
  try {
    await first.session.prompt("/tree-versioning-restore off");
    assert.deepEqual((await second.query("tree_versioning_status")).structuredContent, { restoreEnabled: true });
    await second.command("zh-CN");
    await second.session.reload();
    assert.deepEqual((await second.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
    await first.session.reload();
    await first.command("help");
    assert.match(first.notices.at(-1)!.message, /语言偏好：zh-CN/);
    assert.deepEqual((await first.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
  } finally { dispose(first.session, second.session); }
});

for (const mode of ["rpc", "print", "json"] as const) {
  for (const initial of ["on", "off"] as const) {
    test(`${mode} reports a failed switch save without changing ${initial} or claiming success`, async t => {
      const workspace = await fixture();
      const path = join(workspace.agentDir, "tree-versioning", "preferences.json");
      const rename = fs.rename;
      let fail = false;
      let injected = false;
      const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (fail && args[1] === path) {
          injected = true;
          throw Object.assign(new Error("Simulated preference write failure"), { code: "EIO" });
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
      const app = await load(workspace, undefined, { mode });
      try {
        await app.session.prompt(`/tree-versioning-restore ${initial}`);
        const saved = await readFile(path, "utf8");
        fail = true;
        const choice = initial === "on" ? "off" : "on";
        await app.session.prompt(`/tree-versioning-restore ${choice}`);
        const message = mode === "rpc" ? app.notices.at(-1)!.message : app.errors.at(-1)!;
        assert.match(message, /Could not read or save the extension preferences/);
        assert.doesNotMatch(message, /Preference saved/);
        assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: initial === "on" });
        assert.equal(injected, true, "The filesystem fault must actually be injected");
        assert.equal(await readFile(path, "utf8"), saved);
        fail = false;
        await app.session.prompt(`/tree-versioning-restore ${choice}`);
        assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: choice === "on" });
      } finally { dispose(app.session); }
    });
  }
}

for (const damage of ["corrupt", "unreadable", "link-loop"] as const) {
  test(`${damage} preferences discovered during a language save disable restoration and report an error`, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    try {
      await app.command("en");
      const path = join(workspace.agentDir, "tree-versioning", "preferences.json");
      if (damage === "corrupt") await writeFile(path, "{invalid");
      else {
        await rm(path);
        if (damage === "unreadable") await mkdir(path);
        else await symlink("preferences.json", path);
      }
      const target = app.manager.getLeafId()!;
      app.manager.appendMessage({ role: "user", content: "Keep these files.", timestamp: Date.now() });
      await writeFile(join(workspace.cwd, "notes.txt"), "manual edit\n");
      await app.command("zh-CN");
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.match(app.notices.at(-1)!.message, /extension preferences/);
      assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
      await app.session.navigateTree(target, { summarize: false });
      assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit\n");
      if (damage === "corrupt") assert.equal(await readFile(path, "utf8"), "{invalid");
    } finally { dispose(app.session); }
  });
}

for (const content of ["{invalid", "null", "[]", '{"language":"en","restoreEnabled":"off"}', '{"language":"invalid","restoreEnabled":false}',
  '{"repositoryDepths":null}', '{"repositoryDepths":[]}', '{"repositoryDepths":{"/invalid":-1}}']) {
  test(`unreadable preferences disable restoration without blocking collection: ${content}`, async () => {
    const workspace = await fixture();
    const storage = join(workspace.agentDir, "tree-versioning");
    await mkdir(storage);
    await writeFile(join(storage, "preferences.json"), content);
    const app = await load(workspace);
    try {
      assert.ok(app.notices.some(notice => notice.type === "error" && /extension preferences/.test(notice.message)));
      assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
      assert.equal((await app.checkpoints()).isError, false);
      assert.deepEqual(((await app.diff({ scope: "session" })).details as any).files, []);
      await app.command("en");
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.equal(await readFile(join(storage, "preferences.json"), "utf8"), content);
      assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
      await app.session.reload();
      assert.deepEqual((await app.query("tree_versioning_status")).structuredContent, { restoreEnabled: false });
    } finally { dispose(app.session); }
  });
}
