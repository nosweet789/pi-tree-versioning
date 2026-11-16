import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("baseline contents, language, and the disabled restoration choice survive a fresh process", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  let expected: unknown;
  let sessionFile: string;
  try {
    await app.command("zh-CN");
    await app.session.prompt("/tree-versioning-restore off");
    app.manager.appendMessage({ role: "user", content: "Persist session", timestamp: Date.now() });
    sessionFile = app.manager.getSessionFile()!;
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "hand edit after baseline\n");
    expected = (await app.diff()).details;
  } finally { dispose(app.session); }
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "test/reopen-worker.ts", JSON.stringify(testWorkspace), sessionFile,
  ], { env: { ...process.env, LC_ALL: "en_US.UTF-8" }, timeout: 30000 });
  const reopened = JSON.parse(stdout);
  assert.deepEqual(reopened.diff, expected);
  assert.match(reopened.notice, /语言/);
  assert.deepEqual(reopened.status, { restoreEnabled: false });
});

test("checkpoint associations and saved comparisons survive a fresh process without restoring disk", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  let expected: unknown;
  let sessionFile: string;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "saved round\n");
    await app.session.prompt("Save the round.");
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "unsnapshotted hand edit\n");
    sessionFile = app.manager.getSessionFile()!;
    expected = { diff: (await app.diff()).details, checkpoints: (await app.checkpoints()).details,
      total: (await app.diff({ scope: "session" })).details, status: { restoreEnabled: true } };
  } finally { dispose(app.session); }
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "test/reopen-worker.ts", JSON.stringify(testWorkspace), sessionFile,
  ], { env: process.env, timeout: 30000 });
  const { notice: _notice, ...reopened } = JSON.parse(stdout);
  assert.deepEqual(reopened, expected);
  assert.equal(await readFile(join(testWorkspace.cwd, "notes.txt"), "utf8"), "unsnapshotted hand edit\n");
});
