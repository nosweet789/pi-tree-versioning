import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeITerm2 } from "@earendil-works/pi-tui";
import { responseStream, useModel } from "./agent-fixture.ts";
import { damageCheckpoint } from "./fault-fixture.ts";
import { pauseGitScan } from "./git-gate.ts";
import { dispose, fixture, git, load } from "./harness.ts";
import { nativeUi } from "./native-ui-fixture.ts";
import { nestedRepository, setDepth } from "./nested-fixture.ts";
import { loadRuntime } from "./runtime-fixture.ts";

async function waitFor(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(description);
}

test("here shows the exact checkpoint and overwrite risks before restoring without tree or Git changes", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  const startUi = nativeUi(t, host, "fullscreen", 80);
  const { app } = host;
  const notes = join(workspace.cwd, "notes.txt");
  const unsaved = join(workspace.cwd, "unsaved.txt");
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await writeFile(notes, "saved at this checkpoint\n");
  await app.session.prompt("Record the saved state.");
  const history = (await app.checkpoints()).details as { checkpoints: { id: string; nodeId: string }[] };
  const [checkpoint] = history.checkpoints;
  await app.session.navigateTree(checkpoint.nodeId, { summarize: false });
  await writeFile(notes, "staged edit\n");
  git(workspace.cwd, "add", "notes.txt");
  await writeFile(notes, "unsaved edit\n");
  await writeFile(unsaved, "not in the checkpoint\n");
  const head = git(workspace.cwd, "rev-parse", "HEAD");
  const branch = git(workspace.cwd, "symbolic-ref", "HEAD");
  const index = await readFile(join(workspace.cwd, ".git", "index"));
  const entries = app.manager.getEntries();
  const catalog = (await app.checkpoints()).details;
  const { ui, screen, input, resize } = await startUi();
  const command = app.session.prompt("/tree-versioning-restore here");
  await waitFor(() => screen().includes("Restore files here?"), "The confirmation dialog must open");
  const [, prompt] = screen().split("Restore files here?");
  assert.ok(prompt.includes(checkpoint.id), "The dialog must identify the checkpoint that will be restored");
  assert.doesNotMatch(prompt, /nearest preceding checkpoint/i);
  assert.match(prompt, /unsnapshotted\s+managed\s+edits[^.]*overwritten/i);
  assert.match(prompt, /managed\s+new\s+files[^.]*deleted/i);
  assert.equal(await readFile(notes, "utf8"), "unsaved edit\n");
  assert.equal(await readFile(unsaved, "utf8"), "not in the checkpoint\n");
  resize(80, 5);
  input("\r");
  input("y");
  resize(80, 36);
  assert.match(screen(), /Restore files here\?/, "An unreadable dialog must not accept confirmation");
  assert.equal(await readFile(notes, "utf8"), "unsaved edit\n");

  // Image rows must not overdraw the warning in Pi's editor slot.
  const imageLine = encodeITerm2("R0lGODlhAQABAAAAACwAAAAAAQABAAA=", { width: 1, height: 1 });
  ui.setWidget("test-images", () => ({ render: () => Array<string>(23).fill(imageLine), invalidate() {} }), { placement: "belowEditor" });
  assert.match(screen(), /Unsnapshotted managed edits may be overwritten/);
  input("y");
  await command;
  ui.setWidget("test-images", undefined);
  assert.equal(await readFile(notes, "utf8"), "saved at this checkpoint\n");
  await assert.rejects(stat(unsaved), { code: "ENOENT" });
  assert.equal(app.manager.getLeafId(), checkpoint.nodeId);
  assert.deepEqual(app.manager.getEntries(), entries);
  assert.deepEqual((await app.checkpoints()).details, catalog);
  assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(workspace.cwd, "symbolic-ref", "HEAD"), branch);
  assert.deepEqual(await readFile(join(workspace.cwd, ".git", "index")), index);
});

test("regular terminal here can be cancelled with Escape and requires an explicit restore key", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  const { app } = host;
  const { input, screen } = await nativeUi(t, host, "regular")();
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "unsnapshotted edit\n");
  const cancel = app.session.prompt("/tree-versioning-restore here");
  await waitFor(() => screen().includes("y restore"), "Expected the terminal confirmation");
  input("\r");
  assert.match(screen(), /y restore/, "Enter must not grant consent");
  input("\x1b");
  await cancel;
  assert.equal(await readFile(notes, "utf8"), "unsnapshotted edit\n");

  const approve = app.session.prompt("/tree-versioning-restore here");
  await waitFor(() => screen().includes("y restore"), "Expected the terminal confirmation");
  input("y");
  await approve;
  assert.equal(await readFile(notes, "utf8"), "committed\n");
});

test("here does not write if the displayed checkpoint disappears after confirmation", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const app = await load(workspace, undefined, { confirm: async () => true });
  t.after(() => dispose(app.session));
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await app.session.prompt("Record a checkpoint.");
  const { current } = (await app.checkpoints()).details as { current: { snapshot: { id: string } } };
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "keep this edit\n");
  const gate = await pauseGitScan(workspace);
  const command = app.session.prompt("/tree-versioning-restore here");
  try {
    await gate.wait();
    await damageCheckpoint(workspace, app.manager.getSessionId(), current.snapshot.id, "missing");
  } finally {
    await gate.release();
    await command;
  }
  assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
  assert.match(app.notices.at(-1)!.message, /No usable file history/);
});

test("here does not restore the former workspace if the current directory acquires a different Git root during confirmation", async t => {
  const workspace = await fixture();
  const nested = join(workspace.cwd, "nested");
  await mkdir(nested);
  const app = await load({ ...workspace, cwd: nested }, undefined, { confirm: async () => {
    git(nested, "init", "-q");
    return true;
  } });
  t.after(() => dispose(app.session));
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "keep this edit\n");
  await app.session.prompt("/tree-versioning-restore here");
  assert.equal(git(nested, "rev-parse", "--show-toplevel").trim(), nested);
  assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
  assert.match(app.notices.at(-1)!.message, /different session or workspace/);
});

for (const change of ["replaced", "redirected"] as const) {
  test(`here cannot write if an enrolled repository is ${change} during the last workspace lookup`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    const nested = await nestedRepository(workspace);
    const launch = join(workspace.cwd, "launch");
    await mkdir(launch);
    await setDepth(workspace, 1);
    const app = await load({ ...workspace, cwd: launch }, undefined, { confirm: async () => true });
    t.after(() => dispose(app.session));
    const notes = join(workspace.cwd, "notes.txt");
    const nestedNotes = join(nested, "notes.txt");
    await writeFile(notes, "keep the outer edit\n");
    await writeFile(nestedNotes, "keep the nested edit\n");
    const gate = await pauseGitScan(workspace, [launch, "--show-toplevel"], 1);
    const command = app.session.prompt("/tree-versioning-restore here");
    try {
      await gate.wait();
      if (change === "replaced") {
        await rename(join(nested, ".git"), join(workspace.root, "former-nested-git"));
        git(nested, "init", "-q");
      } else {
        await writeFile(join(nested, ".git", "commondir"), join(workspace.cwd, ".git") + "\n");
      }
    } finally {
      await gate.release();
      await command;
    }
    assert.equal(await readFile(notes, "utf8"), "keep the outer edit\n");
    assert.equal(await readFile(nestedNotes, "utf8"), "keep the nested edit\n");
    assert.match(app.notices.at(-1)!.message, /File restoration failed/);
  });
}

for (const binding of ["Git directory", "common directory"] as const) {
  test(`here does not write if a symbolic link redirects the ${binding} during the last workspace lookup`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    const original = join(workspace.root, "original");
    const replacement = join(workspace.root, "replacement");
    const gitData = join(workspace.root, "git-data");
    await mkdir(original);
    await mkdir(replacement);
    git(workspace.cwd, "init", "--separate-git-dir", join(original, "repo.git"));
    await cp(join(original, "repo.git"), join(replacement, "repo.git"), { recursive: true });
    await symlink(original, gitData, "dir");
    const gitfile = binding === "Git directory";
    const marker = gitfile ? join(workspace.cwd, ".git") : join(original, "repo.git", "commondir");
    const contents = (gitfile ? "gitdir: " : "") + join(gitData, "repo.git") + "\n";
    await writeFile(marker, contents);
    const launch = join(workspace.cwd, "launch");
    await mkdir(launch);
    const app = await load({ ...workspace, cwd: launch }, undefined, { confirm: async () => true });
    t.after(() => dispose(app.session));
    const notes = join(workspace.cwd, "notes.txt");
    await writeFile(notes, "keep this edit\n");
    const gate = await pauseGitScan(workspace, [launch, "--show-toplevel"], 1);
    const command = app.session.prompt("/tree-versioning-restore here");
    const redirect = async (target: string) => {
      const nextLink = join(workspace.root, "next-git-data");
      await symlink(target, nextLink, "dir");
      await rename(nextLink, gitData);
    };
    try {
      await gate.wait();
      await redirect(replacement);
      const actual = git(workspace.cwd, "rev-parse", "--path-format=absolute", gitfile ? "--absolute-git-dir" : "--git-common-dir");
      assert.equal(await realpath(actual.trimEnd()), join(replacement, "repo.git"));
      assert.equal(await readFile(marker, "utf8"), contents);
    } finally {
      await gate.release();
      await command;
    }
    assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
    assert.match(app.notices.at(-1)!.message, /File restoration failed/);
    await redirect(original);
    await app.session.prompt("/tree-versioning-restore here");
    assert.equal(await readFile(notes, "utf8"), "committed\n");
  });
}

test("here preserves edits if the common directory is replaced at the same path during the last workspace lookup", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const gitDirectory = join(workspace.cwd, ".git");
  const common = join(workspace.root, "common");
  const replacement = join(workspace.root, "replacement");
  await cp(gitDirectory, common, { recursive: true });
  await cp(common, replacement, { recursive: true });
  await writeFile(join(gitDirectory, "commondir"), common + "\n");
  const app = await load(workspace, undefined, { confirm: async () => true });
  t.after(() => dispose(app.session));
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "keep this edit\n");
  const gate = await pauseGitScan(workspace, [workspace.cwd, "--show-toplevel"], 2);
  const command = app.session.prompt("/tree-versioning-restore here");
  try {
    await gate.wait();
    await rename(common, join(workspace.root, "former-common-directory"));
    await rename(replacement, common);
  } finally {
    await gate.release();
    await command;
  }
  assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
  assert.match(app.notices.at(-1)!.message, /File restoration failed/);
});

test("here can use a stable common-directory binding with case-aliased paths", async t => {
  const workspace = await fixture();
  const gitDirectory = join(workspace.root, "GitData");
  const alias = join(workspace.root, "GITDATA");
  git(workspace.cwd, "init", "--separate-git-dir", gitDirectory);
  if (await realpath(alias).catch(() => undefined) !== await realpath(gitDirectory)) {
    t.skip("This volume has case-sensitive paths");
    return;
  }
  await writeFile(join(gitDirectory, "commondir"), alias + "\n");
  const app = await load(workspace, undefined, { confirm: async () => true });
  t.after(() => dispose(app.session));
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "unsnapshotted edit\n");
  await app.session.prompt("/tree-versioning-restore here");
  assert.equal(await readFile(notes, "utf8"), "committed\n");
  assert.match(app.notices.at(-1)!.message, /Restored applicable baseline/);
});

test("here asks in Chinese before restoring the applicable baseline and leaves files alone if declined", async t => {
  const workspace = await fixture();
  let approved = false;
  const dialogs: { title: string; body: string }[] = [];
  const app = await load(workspace, undefined, { confirm: async (title, body) => {
    dialogs.push({ title, body });
    return approved;
  } });
  t.after(() => dispose(app.session));
  const notes = join(workspace.cwd, "notes.txt");
  await app.command("zh-CN");
  const { baseline } = (await app.checkpoints()).details as { baseline: { id: string } };
  const leaf = app.manager.getLeafId();
  await writeFile(notes, "unsnapshotted edit\n");
  await app.session.prompt("/tree-versioning-restore here");
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /恢复当前落点/);
  assert.ok(dialogs[0].body.includes(`适用的会话基线 ${baseline.id}`));
  assert.match(dialogs[0].body, /未入快照.*可能被覆盖.*新文件可能被删除/);
  assert.match(app.notices.at(-1)!.message, /已取消文件恢复/);
  assert.equal(await readFile(notes, "utf8"), "unsnapshotted edit\n");
  approved = true;
  await app.session.prompt("/tree-versioning-restore here");
  assert.match(app.notices.at(-1)!.message, /已恢复适用基线/);
  assert.equal(app.manager.getLeafId(), leaf);
  assert.equal(await readFile(notes, "utf8"), "committed\n");
});

test("here restores the nearest preceding checkpoint, not a newer checkpoint from either descendant branch", async t => {
  const workspace = await fixture();
  let preview = "";
  const app = await load(workspace, undefined, { confirm: async (_title, body) => { preview = body; return true; } });
  t.after(() => dispose(app.session));
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "saved ancestor\n");
  await app.session.prompt("Save the shared ancestor.");
  const ancestor = app.manager.getLeafId()!;
  await writeFile(notes, "first branch\n");
  await app.session.prompt("First branch.");
  const firstUser = app.manager.getBranch().find(entry => entry.type === "message" &&
    entry.message.role === "user" && entry.parentId === ancestor)!;
  await app.session.navigateTree(ancestor, { summarize: false });
  await writeFile(notes, "second branch\n");
  await app.session.prompt("Second branch.");
  const { checkpoints: [common, first, second] } = (await app.checkpoints()).details as { checkpoints: { id: string; nodeId: string }[] };
  await app.session.prompt("/tree-versioning-restore off");
  await app.session.navigateTree(firstUser.id, { summarize: false });
  assert.equal(app.manager.getLeafId(), ancestor);
  assert.notEqual(ancestor, common.nodeId);
  await app.session.prompt("/tree-versioning-restore on");
  assert.equal(await readFile(notes, "utf8"), "second branch\n");
  assert.equal(preview, "");
  await app.session.prompt("/tree-versioning-restore here");
  assert.ok(preview.includes(`nearest preceding checkpoint ${common.id}`));
  assert.ok(!preview.includes(first.id) && !preview.includes(second.id));
  assert.equal(await readFile(notes, "utf8"), "saved ancestor\n");
  assert.equal(app.manager.getLeafId(), ancestor);
});

test("here refuses to restore where a late-activation baseline does not cover the current position", async t => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  const oldUser = manager.appendMessage({ role: "user", content: "Older work", timestamp: Date.now() });
  let asked = false;
  const app = await load(workspace, manager, { confirm: async () => { asked = true; return true; } });
  t.after(() => dispose(app.session));
  await app.session.prompt("/tree-versioning-restore off");
  await app.session.navigateTree(oldUser, { summarize: false });
  await app.session.prompt("/tree-versioning-restore on");
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "keep uncovered edits\n");
  await app.session.prompt("/tree-versioning-restore here");
  assert.equal(asked, false);
  assert.match(app.notices.at(-1)!.message, /No usable file history/);
  assert.equal(await readFile(notes, "utf8"), "keep uncovered edits\n");
});

for (const mode of ["print", "rpc"] as const) {
  test(`here leaves files alone when ${mode} cannot confirm`, async t => {
    const workspace = await fixture();
    let asked = false;
    const app = await load(workspace, undefined, { mode, confirm: async () => {
      asked = true;
      throw new Error("Confirmation failed at the UI boundary");
    } });
    t.after(() => dispose(app.session));
    const notes = join(workspace.cwd, "notes.txt");
    await writeFile(notes, "keep these edits\n");
    const entries = app.manager.getEntries();
    await app.session.prompt("/tree-versioning-restore here");
    assert.equal(asked, mode === "rpc");
    assert.match((mode === "print" ? app.errors.at(-1) : app.notices.at(-1)?.message) ?? "", /requires interactive confirmation/);
    assert.equal(await readFile(notes, "utf8"), "keep these edits\n");
    assert.deepEqual(app.manager.getEntries(), entries);
  });
}

for (const change of ["off then on", "new session"] as const) {
  test(`here cannot write after ${change} while confirmation was open`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    let answer!: (approved: boolean) => void;
    let opened!: () => void;
    const confirmation = new Promise<boolean>(resolve => { answer = resolve; });
    const promptOpened = new Promise<void>(resolve => { opened = resolve; });
    const host = await loadRuntime(workspace, undefined, { confirm: async () => { opened(); return confirmation; } });
    t.after(() => host.runtime.dispose());
    const { app } = host;
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Save a checkpoint.");
    const notes = join(workspace.cwd, "notes.txt");
    await writeFile(notes, "unsnapshotted edit\n");
    const command = app.session.prompt("/tree-versioning-restore here");
    try {
      await Promise.race([promptOpened, command.then(() => assert.fail("Expected confirmation before the command completes"))]);
      if (change === "off then on") {
        await app.session.prompt("/tree-versioning-restore off");
        await app.session.prompt("/tree-versioning-restore here");
        assert.match(app.notices.at(-1)!.message, /File restoration is off/);
        await app.session.prompt("/tree-versioning-restore on");
      } else {
        await host.runtime.newSession();
        assert.notEqual(host.app.manager.getSessionId(), app.manager.getSessionId());
      }
      await writeFile(notes, "newer manual edit\n");
    } finally {
      answer(true);
      await command;
    }
    assert.equal(await readFile(notes, "utf8"), "newer manual edit\n");
    assert.deepEqual(app.errors, []);
  });
}

test("here cannot reuse consent after navigation away and back even when tree notifications are delayed", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const release = join(workspace.root, "release-tree-events");
  const addon = join(workspace.root, "delay-tree.ts");
  await writeFile(addon, `
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default pi => pi.on("session_tree", async () => {
  while (!existsSync(${JSON.stringify(release)})) await delay(5);
});
`);
  let answer!: (approved: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { answer = resolve; });
  let asked = false;
  const app = await load(workspace, undefined, { leadingExtensions: [addon],
    confirm: async () => { asked = true; return confirmation; } });
  t.after(() => dispose(app.session));
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await app.session.prompt("Save a checkpoint.");
  const { checkpoints: [checkpoint] } = (await app.checkpoints()).details as { checkpoints: { nodeId: string }[] };
  const leaf = app.manager.getLeafId()!;
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "keep this edit\n");
  const command = app.session.prompt("/tree-versioning-restore here");
  const navigations: Promise<unknown>[] = [];
  try {
    await waitFor(() => asked, "Expected confirmation");
    for (const target of [checkpoint.nodeId, leaf]) {
      navigations.push(app.session.navigateTree(target, { summarize: false }));
      await waitFor(() => app.manager.getLeafId() === target, "Pi did not move the native leaf");
    }
    answer(true);
    await command;
    assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
    assert.match(app.notices.at(-1)!.message, /was superseded/);
  } finally {
    answer(false);
    await writeFile(release, "");
    await Promise.all([command, ...navigations]);
  }
});

test("declining here does not cancel an already running native restore", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  let asked = false;
  const app = await load(workspace, undefined, { confirm: async () => { asked = true; return false; } });
  t.after(() => dispose(app.session));
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await app.session.prompt("Save a checkpoint.");
  const { checkpoints: [checkpoint] } = (await app.checkpoints()).details as { checkpoints: { nodeId: string }[] };
  const notes = join(workspace.cwd, "notes.txt");
  await writeFile(notes, "unsnapshotted edit\n");
  const gate = await pauseGitScan(workspace);
  const native = app.session.navigateTree(checkpoint.nodeId, { summarize: false });
  try {
    await gate.wait();
    await app.session.prompt("/tree-versioning-restore here");
    assert.equal(asked, true);
    assert.equal(await readFile(notes, "utf8"), "unsnapshotted edit\n");
  } finally {
    await gate.release();
    await native;
  }
  assert.equal(await readFile(notes, "utf8"), "committed\n");
  assert.equal(app.manager.getLeafId(), checkpoint.nodeId);
});

test("here cannot write if the current native leaf changes after confirmation", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const app = await load(workspace, undefined, { confirm: async () => true });
  t.after(() => dispose(app.session));
  const notes = join(workspace.cwd, "notes.txt");
  const leaf = app.manager.getLeafId();
  await writeFile(notes, "keep this edit\n");
  const gate = await pauseGitScan(workspace);
  const command = app.session.prompt("/tree-versioning-restore here");
  try {
    await gate.wait();
    app.session.setSessionName("A new native leaf");
    assert.notEqual(app.manager.getLeafId(), leaf);
  } finally {
    await gate.release();
    await command;
  }
  assert.equal(await readFile(notes, "utf8"), "keep this edit\n");
  assert.match(app.notices.at(-1)!.message, /was superseded/);
});
