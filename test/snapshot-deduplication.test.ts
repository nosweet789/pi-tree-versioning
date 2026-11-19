import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { responseStream, useModel, type TestApp } from "./agent-fixture.ts";
import { beforeSnapshotPublication, capturePathsArtifact, damageCheckpoint, damageSharedFileStateIdentity, sharedFileStateArtifact, snapshotDirectory } from "./fault-fixture.ts";
import { pauseGitScan } from "./git-gate.ts";
import { dispose, fixture, git, load, type Fixture } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";
import { renderedHistoryCards as renderedCards } from "./view-fixture.ts";

initTheme("dark", false);

type SavedCheckpoint = { id: string; nodeId: string };

function useQuietModel(app: TestApp) {
  return useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
}

function sessionStorage(workspace: Fixture, app: TestApp) {
  return snapshotDirectory(workspace, app.manager.getSessionId());
}

async function storedBytes(directory: string, seen = new Set<string>()): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { total += await storedBytes(path, seen); continue; }
    const stat = await lstat(path, { bigint: true });
    const inode = `${stat.dev}:${stat.ino}`;
    if (!seen.has(inode)) { total += Number(stat.blocks) * 512; seen.add(inode); }
  }
  return total;
}

test("unchanged rounds save file data once apart from the baseline and remain distinct after reopening", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "asset.bin");
  const contents = randomBytes(256 * 1024);
  await writeFile(path, contents);
  const app = await load(workspace);
  let reopened: TestApp | undefined;
  try {
    const storage = sessionStorage(workspace, app);
    const baselineSize = await storedBytes(storage);
    await app.command("zh-CN");
    await useQuietModel(app);
    await app.session.prompt("Record the first unchanged round.");
    const firstSize = await storedBytes(storage);
    const firstRoundBytes = firstSize - baselineSize;
    assert.ok(firstRoundBytes > baselineSize / 2, "The first round stores its own file data, separate from the baseline");
    await app.session.prompt("Record the second unchanged round.");
    await app.session.prompt("Record the third unchanged round.");
    assert.ok(await storedBytes(storage) - firstSize < firstRoundBytes / 4, "Repeated states add only small checkpoint records");

    const catalog = await app.checkpoints();
    assert.equal(catalog.isError, false);
    const { baseline, checkpoints } = catalog.details as { baseline: { id: string }; checkpoints: SavedCheckpoint[] };
    assert.equal(new Set(checkpoints.map(checkpoint => checkpoint.id)).size, 3);
    assert.deepEqual(checkpoints.map(checkpoint => checkpoint.nodeId), app.manager.getEntries().flatMap(entry =>
      entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []));

    const sessionFile = app.manager.getSessionFile()!;
    dispose(app.session);
    reopened = await load(workspace, SessionManager.open(sessionFile));
    assert.deepEqual((await reopened.checkpoints()).details, catalog.details);
    const cards = renderedCards(reopened);
    assert.equal(cards.length, 3);
    for (const [index, checkpoint] of checkpoints.entries()) {
      assert.match(cards[index], /没有文件变化。/);
      assert.ok(cards[index].includes(checkpoint.id));
      const round = await reopened.diff({ scope: "turn", checkpointId: checkpoint.id });
      assert.equal(round.isError, false);
      const { from, to, files } = round.details as { from: { id: string }; to: { id: string }; files: unknown[] };
      assert.equal(from.id, index === 0 ? baseline.id : checkpoints[index - 1].id);
      assert.equal(to.id, checkpoint.id);
      assert.deepEqual(files, []);
      await writeFile(path, "manual edit\n");
      await reopened.session.navigateTree(checkpoint.nodeId, { summarize: false });
      assert.deepEqual(await readFile(path), contents);
    }
  } finally { dispose((reopened ?? app).session); }
});

async function savedCheckpoints(app: TestApp) {
  const result = await app.checkpoints();
  assert.equal(result.isError, false, JSON.stringify(result.details));
  return (result.details as { checkpoints: SavedCheckpoint[] }).checkpoints;
}

test("a non-adjacent equal file state is reused without changing the round's comparison endpoints", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const notes = join(workspace.cwd, "notes.txt");
  const asset = randomBytes(256 * 1024);
  try {
    await app.command("en");
    await useQuietModel(app);
    await writeFile(join(workspace.cwd, "asset.bin"), asset);
    await app.session.prompt("First file state.");
    const firstSize = await storedBytes(sessionStorage(workspace, app));
    await writeFile(notes, "middle state\n");
    await app.session.prompt("Different file state.");
    const differentSize = await storedBytes(sessionStorage(workspace, app));
    // Staging changes Git's enumeration order, not the captured file states.
    git(workspace.cwd, "add", "asset.bin");
    await writeFile(notes, "committed\n");
    await app.session.prompt("Return to the first file state.");
    assert.ok(await storedBytes(sessionStorage(workspace, app)) - differentSize < (differentSize - firstSize) / 4);
    const [first, middle, last] = await savedCheckpoints(app);
    const round = await app.diff({ scope: "turn", checkpointId: last.id });
    assert.equal(round.isError, false);
    const { from, to, files } = round.details as { from: { id: string }; to: { id: string }; files: { patch: string }[] };
    assert.equal(from.id, middle.id);
    assert.equal(to.id, last.id);
    assert.match(files[0].patch, /-middle state\n\+committed/);
    const card = renderedCards(app).at(-1)!;
    assert.ok(card.includes(middle.id) && card.includes(last.id));
    assert.doesNotMatch(card, /No file changes/);
    for (const [checkpoint, expected] of [[first, "committed\n"], [middle, "middle state\n"], [last, "committed\n"]] as const) {
      await app.session.navigateTree(checkpoint.nodeId, { summarize: false });
      assert.equal(await readFile(notes, "utf8"), expected);
    }
  } finally { dispose(app.session); }
});

test("path, presence, executable bit, file kind and link target all survive checkpoint restoration", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const item = join(workspace.cwd, "item");
  const moved = join(workspace.cwd, "moved");
  const assertAbsent = async (path: string) => assert.rejects(lstat(path), { code: "ENOENT" });
  const assertRegular = async (path: string, contents: string, executable: boolean) => {
    const stat = await lstat(path);
    assert.ok(stat.isFile());
    assert.equal((stat.mode & 0o111) !== 0, executable);
    assert.equal(await readFile(path, "utf8"), contents);
  };
  try {
    await useQuietModel(app);
    await writeFile(item, "notes.txt", { mode: 0o644 });
    await app.session.prompt("Regular non-executable file.");
    await chmod(item, 0o755);
    await app.session.prompt("Change the executable bit only.");
    await rm(item);
    await symlink("notes.txt", item);
    await app.session.prompt("Change the file kind without changing the stored bytes.");
    await rm(item);
    await symlink("./notes.txt", item);
    await app.session.prompt("Change only the raw symbolic link target.");
    await rm(item);
    await app.session.prompt("Remove the entry.");
    await writeFile(item, "", { mode: 0o644 });
    await app.session.prompt("Create an empty file where there was no entry.");
    await rename(item, moved);
    await app.session.prompt("Keep the same contents at a different path.");

    const checkpoints = await savedCheckpoints(app);
    const verify = [
      () => assertRegular(item, "notes.txt", false),
      () => assertRegular(item, "notes.txt", true),
      async () => assert.equal(await readlink(item), "notes.txt"),
      async () => assert.equal(await readlink(item), "./notes.txt"),
      () => assertAbsent(item),
      () => assertRegular(item, "", false),
      async () => { await assertAbsent(item); await assertRegular(moved, "", false); },
    ];
    assert.equal(checkpoints.length, verify.length);
    for (const [index, checkpoint] of checkpoints.entries()) {
      await app.session.navigateTree(checkpoint.nodeId, { summarize: false });
      await verify[index]();
      if (index < verify.length - 1) await assertAbsent(moved);
    }
  } finally { dispose(app.session); }
});

for (const damage of ["missing", "corrupt"] as const) {
  test(`a ${damage} shared file state fails both queries and native restores without falling back`, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    const path = join(workspace.cwd, "notes.txt");
    try {
      await useQuietModel(app);
      await app.session.prompt("Save a different preceding state.");
      await writeFile(path, "shared state\n");
      await app.session.prompt("Save the shared state.");
      await app.session.prompt("Reuse the shared state.");
      const [older, ...shared] = await savedCheckpoints(app);
      const statePath = await sharedFileStateArtifact(workspace, app.manager.getSessionId(), shared[0].id);
      if (damage === "missing") await rm(statePath);
      else await writeFile(statePath, "{}"); // Well-formed JSON, but not the referenced file state.
      await writeFile(path, "manual edit remains\n");
      for (const result of [await app.checkpoints(), await app.diff(), await app.diff({ scope: "session" }),
        ...await Promise.all(shared.map(({ id }) => app.diff({ scope: "turn", checkpointId: id })))]) {
        assert.equal(result.isError, true);
        assert.equal((result.details as { code: string }).code, "snapshot_unavailable");
      }
      assert.equal((await app.diff({ scope: "turn", checkpointId: older.id })).isError, false);
      for (const checkpoint of shared) {
        await app.session.navigateTree(checkpoint.nodeId, { summarize: false });
        assert.equal(app.manager.getLeafId(), checkpoint.nodeId);
        assert.match(app.notices.at(-1)!.message, /no files were restored/);
        assert.equal(await readFile(path, "utf8"), "manual edit remains\n");
      }
    } finally { dispose(app.session); }
  });
}

test("recapturing identical contents never makes a checkpoint that lost its data available again", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const path = join(workspace.cwd, "notes.txt");
  try {
    await useQuietModel(app);
    await app.session.prompt("Save the first state.");
    await writeFile(path, "a different state\n");
    await app.session.prompt("Save a different predecessor.");
    const [first, second] = await savedCheckpoints(app);
    await rm(await sharedFileStateArtifact(workspace, app.manager.getSessionId(), first.id));
    await writeFile(path, "committed\n");
    await app.session.prompt("Capture the earlier file state again.");
    const current = await app.diff({ scope: "turn" });
    assert.equal(current.isError, false);
    const { from, to } = current.details as { from: { id: string }; to: SavedCheckpoint };
    assert.equal(from.id, second.id);
    assert.notEqual(to.id, first.id);
    assert.equal(renderedCards(app).length, 3);
    assert.equal((await app.diff({ scope: "turn", checkpointId: first.id })).isError, true);
    await writeFile(path, "manual edit remains\n");
    await app.session.navigateTree(first.nodeId, { summarize: false });
    assert.equal(await readFile(path, "utf8"), "manual edit remains\n");
    assert.match(app.notices.at(-1)!.message, /no files were restored/);
    await app.session.navigateTree(to.nodeId, { summarize: false });
    assert.equal(await readFile(path, "utf8"), "committed\n");
  } finally { dispose(app.session); }
});

test("recapturing a non-adjacent state fails if its saved publication is corrupt", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const path = join(workspace.cwd, "notes.txt");
  try {
    await useQuietModel(app);
    await app.session.prompt("Save the first state.");
    await writeFile(path, "a different state\n");
    await app.session.prompt("Save a different predecessor.");
    const [first, second] = await savedCheckpoints(app);
    await damageSharedFileStateIdentity(workspace, app.manager.getSessionId(), first.id);
    await writeFile(path, "committed\n");
    await app.session.prompt("Refuse to reuse the corrupt first state.");
    assert.match(app.notices.at(-1)!.message, /round was not recorded/);
    assert.equal(renderedCards(app).length, 2);
    const current = await app.diff({ scope: "session" });
    assert.equal(current.isError, false);
    assert.equal((current.details as { to: SavedCheckpoint }).to.id, second.id);
  } finally { dispose(app.session); }
});

test("a missing predecessor file state still allows safe capture with a comparison error card", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    await useQuietModel(app);
    await app.session.prompt("Save the first checkpoint.");
    const [first] = await savedCheckpoints(app);
    await rm(await sharedFileStateArtifact(workspace, app.manager.getSessionId(), first.id));
    await app.session.prompt("Record an unchanged workspace despite the missing predecessor.");
    const total = await app.diff({ scope: "session" });
    assert.equal(total.isError, false);
    assert.notEqual((total.details as { to: SavedCheckpoint }).to.id, first.id);
    const cards = renderedCards(app);
    assert.equal(cards.length, 2);
    assert.match(cards[1], /checkpoint was recorded.*diff is unavailable/);
    const round = await app.diff({ scope: "turn" });
    assert.equal(round.isError, true);
    assert.equal((round.details as { code: string }).code, "snapshot_unavailable");
  } finally { dispose(app.session); }
});

for (const missing of ["file state", "checkpoint", "file state and path evidence"] as const) {
  test(`a missing predecessor ${missing} cannot hide a new repository boundary from capture`, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    const directory = join(workspace.cwd, "later-directory");
    try {
      await useQuietModel(app);
      await mkdir(directory);
      await writeFile(join(directory, "notes.txt"), "first managed after the baseline\n");
      await app.session.prompt("Save the path before it becomes a repository.");
      const [first] = await savedCheckpoints(app);
      const sessionId = app.manager.getSessionId();
      if (missing === "checkpoint") await damageCheckpoint(workspace, sessionId, first.id, "missing");
      else await rm(await sharedFileStateArtifact(workspace, sessionId, first.id));
      if (missing === "file state and path evidence") await rm(capturePathsArtifact(workspace, sessionId, first.id));
      git(directory, "init", "-q");
      await app.session.prompt("Do not treat the repository boundary as deletion.");
      assert.equal(renderedCards(app).length, 1);
      assert.match(app.notices.at(-1)!.message, /round was not recorded/);
      assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "first managed after the baseline\n");
    } finally { dispose(app.session); }
  });
}

test("losing a shared file state during native restore preflight prevents workspace writes", { timeout: 10000 }, async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const path = join(workspace.cwd, "notes.txt");
  let gate: Awaited<ReturnType<typeof pauseGitScan>> | undefined;
  let navigation: Promise<unknown> | undefined;
  try {
    await useQuietModel(app);
    await app.session.prompt("Record the first checkpoint.");
    await app.session.prompt("Record the second checkpoint.");
    const [first] = await savedCheckpoints(app);
    const statePath = await sharedFileStateArtifact(workspace, app.manager.getSessionId(), first.id);
    await writeFile(path, "manual edit remains\n");
    gate = await pauseGitScan(workspace);
    navigation = app.session.navigateTree(first.nodeId, { summarize: false });
    await gate.wait();
    await rm(statePath);
    await gate.release();
    gate = undefined;
    await navigation;
    assert.equal(app.manager.getLeafId(), first.nodeId);
    assert.match(app.notices.at(-1)!.message, /no files were restored/);
    assert.equal(await readFile(path, "utf8"), "manual edit remains\n");
  } finally {
    await gate?.release();
    await navigation;
    dispose(app.session);
  }
});

for (const failedArtifact of ["file state", "checkpoint"] as const) {
  test(`failed publication of the ${failedArtifact} does not expose a successful checkpoint`, async t => {
    const workspace = await fixture();
    const contents = randomBytes(256 * 1024);
    const inject = beforeSnapshotPublication(t, failedArtifact);
    let injected = false;
    const app = await load(workspace);
    try {
      await useQuietModel(app);
      assert.deepEqual(await savedCheckpoints(app), []);
      await writeFile(join(workspace.cwd, "asset.bin"), contents);
      inject(sessionStorage(workspace, app), async () => {
        injected = true;
        throw Object.assign(new Error("Injected publication failure"), { code: "EIO" });
      });
      await app.session.prompt("Try to record the new file state.");
      assert.equal(injected, true, "Publication must encounter the injected filesystem fault");
      assert.match(app.notices.at(-1)!.message, /round was not recorded/);
      assert.deepEqual(await savedCheckpoints(app), []);
      assert.deepEqual(renderedCards(app), []);
      assert.deepEqual(await readFile(join(workspace.cwd, "asset.bin")), contents);
    } finally { dispose(app.session); }
  });
}

test("losing reused data just before publication aborts the new checkpoint", async t => {
  const workspace = await fixture();
  const inject = beforeSnapshotPublication(t, "checkpoint");
  let injected = false;
  const app = await load(workspace);
  try {
    await useQuietModel(app);
    await app.session.prompt("Save the first checkpoint.");
    const [first] = await savedCheckpoints(app);
    const path = await sharedFileStateArtifact(workspace, app.manager.getSessionId(), first.id);
    inject(sessionStorage(workspace, app), async () => {
      await rm(path);
      injected = true;
    });
    await app.session.prompt("Try to record a checkpoint sharing the data.");
    assert.equal(injected, true, "The filesystem fault must occur before publication completes");
    assert.equal(renderedCards(app).length, 1);
    assert.match(app.notices.at(-1)!.message, /round was not recorded/);
  } finally { dispose(app.session); }
});

for (const operation of ["fork", "clone"] as const) {
  test(`${operation} keeps shared file data independently of the source session`, async () => {
    const workspace = await fixture();
    const path = join(workspace.cwd, "asset.bin");
    const contents = randomBytes(256 * 1024);
    await writeFile(path, contents);
    const host = await loadRuntime(workspace);
    try {
      await useQuietModel(host.app);
      const sourceStorage = sessionStorage(workspace, host.app);
      const baselineBytes = await storedBytes(sourceStorage);
      await host.app.session.prompt("Save the first round.");
      const firstRoundBytes = await storedBytes(sourceStorage) - baselineBytes;
      await host.app.session.prompt("Save the second round.");
      await host.app.session.prompt("Save the third round.");
      const inheritedBytes = await storedBytes(sourceStorage);
      const ancestors = await savedCheckpoints(host.app);
      const copiedLeaf = host.app.manager.getLeafId()!;
      await writeFile(join(workspace.cwd, "notes.txt"), "on the source only\n");
      await host.app.session.prompt("Do not copy this round.");
      const user = host.app.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
      const sourceFile = host.app.manager.getSessionFile()!;
      await writeFile(path, "manual edit\n");
      const fork = operation === "fork";
      await host.runtime.fork(fork ? user.id : copiedLeaf, { position: fork ? "before" : "at" });
      assert.deepEqual(await readFile(path), fork ? contents : Buffer.from("manual edit\n"));
      assert.ok(await storedBytes(sessionStorage(workspace, host.app)) <= inheritedBytes + firstRoundBytes / 4,
        "The copied history stays deduplicated in the child");

      await rm(sourceFile);
      await rm(sourceStorage, { recursive: true });
      await host.app.session.reload();
      const checkpoints = await savedCheckpoints(host.app);
      assert.deepEqual(checkpoints.map(checkpoint => checkpoint.id), ancestors.map(checkpoint => checkpoint.id));
      for (const checkpoint of checkpoints) {
        const round = await host.app.diff({ scope: "turn", checkpointId: checkpoint.id });
        assert.equal(round.isError, false);
        assert.deepEqual((round.details as { files: unknown[] }).files, []);
        await writeFile(path, "another manual edit\n");
        await host.app.session.navigateTree(checkpoint.nodeId, { summarize: false });
        assert.deepEqual(await readFile(path), contents);
      }
    } finally { await host.runtime.dispose(); }
  });
}
