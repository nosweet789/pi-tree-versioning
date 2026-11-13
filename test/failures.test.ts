import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";

test("a saved snapshot replaced by a FIFO reports an error rather than hanging", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  app.manager.appendMessage({ role: "user", content: "Persist session", timestamp: Date.now() });
  const sessionFile = app.manager.getSessionFile()!;
  try {
    const directory = join(testWorkspace.agentDir, "tree-versioning", app.manager.getSessionId());
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      await rm(path);
      execFileSync("mkfifo", [path]);
    }
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "test/reopen-worker.ts", JSON.stringify(testWorkspace), sessionFile,
    ], { env: process.env, timeout: 3000 });
    assert.equal(JSON.parse(stdout).diff.code, "snapshot_unavailable");
  } finally { dispose(app.session); }
});

for (const damage of ["missing", "corrupt"] as const) {
  test(`${damage} saved baseline never becomes a new successful baseline on reload`, async () => {
    const testWorkspace = await fixture();
    const app = await load(testWorkspace);
    try {
      const storage = join(testWorkspace.agentDir, "tree-versioning", app.manager.getSessionId());
      if (damage === "missing") await rm(storage, { recursive: true });
      else {
        for (const name of await readdir(storage)) await writeFile(join(storage, name), "{}");
      }
      const entries = app.manager.getEntries();
      const failed = await app.diff();
      assert.equal(failed.isError, true);
      assert.equal((failed.details as any).code, "snapshot_unavailable");
      await writeFile(join(testWorkspace.cwd, "notes.txt"), "must not become baseline\n");
      await app.session.reload();
      assert.equal((await app.diff()).isError, true);
      assert.deepEqual(app.manager.getEntries(), entries);
      assert.equal(app.notices.at(-1)?.type, "error");
    } finally { dispose(app.session); }
  });
}

test("failed collection is distinct from an empty diff and never publishes a partial baseline", async () => {
  const testWorkspace = await fixture();
  const fifo = join(testWorkspace.cwd, "notes.txt");
  await rm(fifo);
  execFileSync("mkfifo", [fifo]);
  const app = await load(testWorkspace);
  try {
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.equal(app.manager.getLeafId(), app.startupLeaf);
    const failed = await app.diff();
    assert.equal(failed.isError, true);
    assert.equal((failed.details as any).code, "no_baseline");
    await rm(fifo);
    assert.equal((await app.diff()).isError, true, "A query must not silently create the baseline");
    await writeFile(fifo, "readable again\n");
    await app.session.reload();
    assert.deepEqual(((await app.diff()).details as any).files, []);
    const entries = app.manager.getEntries();
    await rm(fifo);
    execFileSync("mkfifo", [fifo]);
    const queryFailure = await app.diff();
    assert.equal(queryFailure.isError, true);
    assert.equal((queryFailure.details as any).code, "capture_failed");
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
});
