import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { dispose, fixture, load } from "./harness.ts";

test("baseline contents and language preference survive a fresh process", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  let expected: unknown;
  let sessionFile: string;
  try {
    await app.command("zh-CN");
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
});
