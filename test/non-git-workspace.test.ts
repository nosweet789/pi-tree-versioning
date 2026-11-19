import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, responseStream, useModel } from "./agent-fixture.ts";
import { interceptGit } from "./git-gate.ts";
import { dispose, fixture, git, load } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";

test("a session outside Git chats without starting file history or showing errors", async () => {
  const workspace = await fixture({ repository: false });
  const app = await load(workspace, undefined, { mode: "tui" });
  try {
    assert.deepEqual(app.notices, []);
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("First round.");
    await app.session.prompt("Second round.");
    assert.equal(app.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").length, 2);
    assert.equal(app.manager.getEntries().some(entry => entry.type === "custom"), false);
    const catalog = await app.checkpoints();
    assert.equal(catalog.isError, true);
    assert.equal((catalog.details as { code?: string }).code, "no_baseline");
    assert.deepEqual(app.notices, []);
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});

test("the diff command outside Git shows a localized informational notice instead of a viewer", async () => {
  const workspace = await fixture({ repository: false });
  const app = await load(workspace, undefined, { mode: "tui", custom: async () => assert.fail("No viewer should open") });
  try {
    for (const [locale, message] of [
      ["en", "The current directory is outside a Git working tree; file diffs are unavailable."],
      ["zh-CN", "当前目录不在 Git 工作区内，无法查看文件差异。"],
    ]) {
      await app.command(locale);
      const before = app.notices.length;
      await app.session.prompt("/tree-versioning-diff");
      assert.deepEqual(app.notices.slice(before), [{ message, type: "info" }]);
    }
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});

test("headless diff commands show a localized notice without writing it to the output stream", async () => {
  const workspace = await fixture({ repository: false });
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const entry = process.env.TREE_VERSIONING_TEST_PACKAGE ?? resolve("src/index.ts");
  const { PATH, HOME, TMPDIR, XDG_CACHE_HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM } = process.env;
  for (const mode of ["print", "json"] as const) {
    const run = promisify(execFile)(process.execPath, [
      cli, "--offline", "-ne", "-e", entry, "--no-mcp", "--no-approve",
      ...(mode === "print" ? ["-p"] : ["--mode", "json"]), "/tree-versioning-diff",
    ], {
      cwd: workspace.cwd, timeout: 10_000,
      env: { PATH, HOME, TMPDIR, XDG_CACHE_HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM,
        PI_CODING_AGENT_DIR: workspace.agentDir, PI_TELEMETRY: "0", LC_ALL: "zh_CN.UTF-8" },
    });
    run.child.stdin!.end();
    const { stdout, stderr } = await run;
    assert.equal(stderr.trim(), "当前目录不在 Git 工作区内，无法查看文件差异。");
    if (mode === "print") assert.equal(stdout, "");
    else assert.equal(JSON.parse(stdout.trim()).type, "session");
  }
});

test("native tree navigation, fork, and clone outside Git leave files and session history alone", async () => {
  const workspace = await fixture({ repository: false });
  const host = await loadRuntime(workspace, undefined, { mode: "tui" });
  const source = host.app;
  try {
    await useModel(source, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await source.session.prompt("Keep this round.");
    const destination = source.manager.getLeafId()!;
    await source.session.prompt("Leave this branch.");
    const path = join(workspace.cwd, "notes.txt");
    await writeFile(path, "unsaved edit\n");

    assert.equal((await source.session.navigateTree(destination, { summarize: false })).cancelled, false);
    assert.equal(source.manager.getLeafId(), destination);
    const next = source.manager.appendMessage({ role: "user", content: "Fork before this message.", timestamp: Date.now() });
    assert.equal((await host.runtime.fork(next)).cancelled, false);
    const fork = host.app;
    assert.notEqual(fork.manager.getSessionId(), source.manager.getSessionId());
    assert.equal(fork.manager.getLeafId(), destination);
    assert.equal(fork.manager.getEntry(next), undefined);

    const leaf = fork.manager.getLeafId()!;
    assert.equal((await host.runtime.fork(leaf, { position: "at" })).cancelled, false);
    const clone = host.app;
    assert.notEqual(clone.manager.getSessionId(), fork.manager.getSessionId());
    assert.equal(clone.manager.getLeafId(), leaf);
    assert.equal(await readFile(path, "utf8"), "unsaved edit\n");
    for (const app of [source, fork, clone]) {
      assert.deepEqual(app.notices, []);
      assert.deepEqual(app.errors, []);
      assert.equal(app.manager.getEntries().some(entry => entry.type === "custom"), false);
    }
  } finally { await host.runtime.dispose(); }
});

test("a covered worktree that disappears is still an error on reload and subsequent rounds", async () => {
  const workspace = await fixture();
  const app = await load(workspace, undefined, { mode: "tui" });
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Record while the worktree is present.");
    assert.equal((await app.checkpoints()).isError, false);
    await rename(join(workspace.cwd, ".git"), join(workspace.root, "removed-git"));

    const before = app.notices.length;
    await app.session.reload();
    assert.equal(app.notices[before]?.type, "error");
    assert.match(app.notices[before]!.message, /Baseline unavailable/);
    await app.session.prompt("The repository is still missing.");
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.match(app.notices.at(-1)!.message, /This round was not recorded/);
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(app.notices.at(-1)?.type, "error");
  } finally { dispose(app.session); }
});

for (const copies of [1, 2]) test(`inherited coverage survives ${copies} native ${copies === 1 ? "copy" : "copies"} during worktree loss`, async () => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  manager.appendMessage({ role: "user", content: "Before file history was enabled.", timestamp: Date.now() });
  const target = manager.appendMessage(assistant({ content: [{ type: "text", text: "Earlier reply." }] }));
  const selected = manager.appendMessage({ role: "user", content: "Fork before this message.", timestamp: Date.now() });
  const host = await loadRuntime(workspace, manager, { mode: "tui" });
  try {
    const original = await host.app.checkpoints();
    assert.equal(original.isError, false);
    const gitDirectory = join(workspace.cwd, ".git");
    const displaced = join(workspace.root, "moved-git");
    await rename(gitDirectory, displaced);
    await writeFile(join(workspace.cwd, "notes.txt"), "edit made without Git\n");

    assert.equal((await host.runtime.fork(selected)).cancelled, false);
    assert.ok(host.app.manager.getBranch().some(entry => entry.id === target));
    assert.equal(host.app.manager.getEntry(selected), undefined);
    assert.equal(host.app.notices.at(-1)?.type, "error");
    assert.match(host.app.notices.at(-1)!.message, /File history inheritance/);
    assert.equal((await host.app.checkpoints()).isError, true);
    if (copies === 2) {
      assert.equal((await host.runtime.fork(target, { position: "at" })).cancelled, false);
      assert.equal(host.app.notices.at(-1)?.type, "error");
      assert.equal((await host.app.checkpoints()).isError, true);
    }

    await rename(displaced, gitDirectory);
    await host.app.session.reload();
    const recovered = await host.app.checkpoints();
    assert.equal(recovered.isError, false, JSON.stringify(recovered.details));
    assert.equal((recovered.details as any).baseline.id, (original.details as any).baseline.id);
    assert.deepEqual((recovered.details as any).coverage, (original.details as any).coverage);
    assert.equal((recovered.details as any).current.snapshot, null);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "edit made without Git\n");
  } finally { await host.runtime.dispose(); }
});

test("a copy that contains only checkpoint associations does not silently skip lost file history", async () => {
  const workspace = await fixture();
  const manager = SessionManager.create(workspace.cwd, join(workspace.root, "sessions"));
  manager.appendMessage({ role: "user", content: "Before file history was enabled.", timestamp: Date.now() });
  const anchor = manager.appendMessage(assistant({ content: [{ type: "text", text: "Earlier reply." }] }));
  const host = await loadRuntime(workspace, manager, { mode: "tui" });
  try {
    await host.app.session.navigateTree(anchor, { summarize: false });
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await host.app.session.prompt("Save a checkpoint from the anchor.");
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    assert.equal((await host.app.checkpoints()).isError, false);
    const entries = host.app.manager.getEntries().flatMap(entry => entry.type === "custom" ? [entry.customType] : []);
    assert.deepEqual(entries, ["tree-versioning.checkpoint"]);

    await rename(join(workspace.agentDir, "tree-versioning"), join(workspace.root, "moved-history"));
    await rename(join(workspace.cwd, ".git"), join(workspace.root, "moved-git"));
    await host.app.session.reload();
    assert.equal(host.app.notices.at(-1)?.type, "error");
    assert.match(host.app.notices.at(-1)!.message, /Baseline unavailable/);
    assert.equal(((await host.app.checkpoints()).details as { code?: string }).code, "snapshot_unavailable");
  } finally { await host.runtime.dispose(); }
});

for (const operation of ["fork", "clone"] as const) {
  test(`${operation} from a skipped session can start file history once a worktree exists`, async () => {
    const workspace = await fixture({ repository: false });
    const host = await loadRuntime(workspace, undefined, { mode: "tui" });
    try {
      await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await host.app.session.prompt("Chat before Git exists.");
      const cloneTarget = host.app.manager.getLeafId()!;
      const forkTarget = host.app.manager.appendMessage({ role: "user", content: "Fork here.", timestamp: Date.now() });
      git(workspace.cwd, "init", "-q");
      await host.app.session.prompt("/tree-versioning-diff");
      assert.deepEqual(host.app.notices.at(-1), {
        message: "File versioning was skipped for this session at startup. Run /reload to enable it in the Git working tree.", type: "info",
      });
      assert.equal(((await host.app.checkpoints()).details as { code?: string }).code, "no_baseline");
      const notes = join(workspace.cwd, "notes.txt");
      await writeFile(notes, "keep this work\n");

      await host.runtime.fork(operation === "fork" ? forkTarget : cloneTarget, { position: operation === "fork" ? "before" : "at" });
      const child = await host.app.checkpoints();
      assert.equal(child.isError, false, JSON.stringify(host.app.notices));
      assert.equal(host.app.notices.some(notice => notice.type === "error"), false);
      assert.equal(await readFile(notes, "utf8"), "keep this work\n");
      await host.app.session.reload();
      assert.deepEqual((await host.app.checkpoints()).details, child.details);
    } finally { await host.runtime.dispose(); }
  });
}

test("a clone without saved history can start file versioning after a startup fault is cleared", async () => {
  const workspace = await fixture({ repository: false });
  const gitDirectory = join(workspace.cwd, ".git");
  await mkdir(gitDirectory);
  const host = await loadRuntime(workspace, undefined, { mode: "tui" });
  try {
    assert.equal(host.app.notices.at(-1)?.type, "error");
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await host.app.session.prompt("Chat without a baseline.");
    await rename(gitDirectory, join(workspace.root, "invalid-marker"));

    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    assert.deepEqual(host.app.notices, []);
    git(workspace.cwd, "init", "-q");
    await host.app.session.reload();
    const catalog = await host.app.checkpoints();
    assert.equal(catalog.isError, false, JSON.stringify(catalog.details));
  } finally { await host.runtime.dispose(); }
});

test("an interrupted ephemeral clone keeps its handoff out of the next session", async () => {
  const workspace = await fixture();
  let interrupt = true;
  const host = await loadRuntime(workspace, SessionManager.inMemory(workspace.cwd), { mode: "tui" }, {
    async beforeLoad() {
      if (!interrupt) return;
      interrupt = false;
      await rename(join(workspace.cwd, ".git"), join(workspace.root, "moved-git"));
    },
  });
  try {
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await host.app.session.prompt("Create a checkpoint before the interruption.");
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    assert.equal(host.app.notices.at(-1)?.type, "error");

    await host.runtime.newSession();
    assert.deepEqual(host.app.notices, []);
    await host.app.session.reload();
    assert.deepEqual(host.app.notices, []);
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await host.app.session.prompt("Chat in an unrelated, non-Git session.");
    await host.runtime.fork(host.app.manager.getLeafId()!, { position: "at" });
    assert.deepEqual(host.app.notices, []);
    assert.deepEqual(host.app.errors, []);
  } finally { await host.runtime.dispose(); }
});

test("a healthy bare repository has no working tree, so startup and the diff command do not report errors", async () => {
  const workspace = await fixture({ repository: false });
  git(workspace.cwd, "init", "--bare", "-q");
  const app = await load(workspace, undefined, { mode: "tui" });
  try {
    assert.deepEqual(app.notices, []);
    await app.session.prompt("/tree-versioning-diff");
    assert.deepEqual(app.notices, [{ message: "The current directory is outside a Git working tree; file diffs are unavailable.", type: "info" }]);
  } finally { dispose(app.session); }
});

test("Git's discovery ceiling excludes repositories above the session's discovery range", async () => {
  const workspace = await fixture();
  const cwd = join(workspace.cwd, "child");
  await mkdir(cwd);
  // The ceiling directory itself is not searched.
  process.env.GIT_CEILING_DIRECTORIES = workspace.cwd;
  try {
    const app = await load({ ...workspace, cwd }, undefined, { mode: "tui" });
    try { assert.deepEqual(app.notices, []); }
    finally { dispose(app.session); }
  } finally { delete process.env.GIT_CEILING_DIRECTORIES; }
});

test("a Git marker beyond the filesystem boundary does not make an unrelated directory faulty", async () => {
  const workspace = await fixture();
  const mount = join(workspace.cwd, "mounted disk");
  const cwd = join(mount, "session");
  await mkdir(cwd, { recursive: true });
  const diagnostic = `fatal: not a git repository (or any parent up to mount point ${mount})\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n`;
  // Reproduce Git's filesystem-boundary diagnostic without mounting a volume.
  const restorePath = await interceptGit(workspace, `
if (args[0] === "-C" && args[1] === ${JSON.stringify(cwd)} && args.includes("rev-parse")) {
  process.stderr.write(${JSON.stringify(diagnostic)});
  return 128;
}
`);
  try {
    const app = await load({ ...workspace, cwd }, undefined, { mode: "tui" });
    try { assert.deepEqual(app.notices, []); }
    finally { dispose(app.session); }
  } finally { restorePath(); }
});

test("an invalid repository marker in a parent directory is not a silent skip", async () => {
  const workspace = await fixture({ repository: false });
  await mkdir(join(workspace.cwd, ".git"));
  const child = join(workspace.cwd, "child");
  await mkdir(child);
  const app = await load({ ...workspace, cwd: child }, undefined, { mode: "print", expectedStartupErrors: 1 });
  try { assert.match(app.errors[0], /Baseline unavailable/); }
  finally { dispose(app.session); }
});

for (const failure of ["ENOENT", "EACCES"] as const) {
  test(`Git failing to launch with ${failure} is not a silent skip`, async () => {
    const workspace = await fixture({ repository: false });
    const commands = join(workspace.root, "commands");
    await mkdir(commands);
    if (failure === "EACCES") await writeFile(join(commands, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const path = process.env.PATH!;
    process.env.PATH = commands;
    try {
      const app = await load(workspace, undefined, { mode: "print", expectedStartupErrors: 1 });
      try { assert.match(app.errors[0], new RegExp(`Baseline unavailable.*${failure}`)); }
      finally { dispose(app.session); }
    } finally { process.env.PATH = path; }
  });
}
