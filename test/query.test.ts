import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";

test("programmatic queries return language-independent structured comparisons and bounded errors", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  const previousPath = process.env.PATH;
  const previousTemporaryDirectory = process.env.TMPDIR;
  try {
    assert.ok(app.session.extensionRunner.getToolDefinition("session_diff")!.outputSchema);
    const result = await app.diff();
    assert.deepEqual(result.structuredContent, result.details);
    const commands = join(testWorkspace.root, "commands");
    await mkdir(commands);
    await writeFile(join(commands, "git"), `#!${process.execPath}\nprocess.stderr.write("Large diagnostic. ".repeat(10000)); process.exitCode = 1;\n`, { mode: 0o700 });
    process.env.PATH = commands + ":" + previousPath;
    const failed = await app.diff();
    assert.equal(failed.isError, true);
    const text = failed.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.ok(Buffer.byteLength(text) < 53 * 1024);
    assert.deepEqual(failed.structuredContent, failed.details);
    assert.equal((failed.details as any).diagnosticTruncated, true);
    const diagnostic = await readFile((failed.details as any).diagnosticPath, "utf8");
    assert.ok(Buffer.byteLength(diagnostic) > 53 * 1024);
    process.env.TMPDIR = testWorkspace.cwd;
    const exportFailure = await app.diff();
    assert.equal((exportFailure.details as any).diagnosticExportFailed, true);
    assert.equal((exportFailure.details as any).code, (failed.details as any).code);
    assert.equal((exportFailure.details as any).diagnostic, (failed.details as any).diagnostic);
  } finally {
    process.env.PATH = previousPath;
    process.env.TMPDIR = previousTemporaryDirectory;
    dispose(app.session);
  }
});

test("large diff output is bounded and points to a complete comparison outside the workspace", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await writeFile(join(testWorkspace.cwd, "large.txt"), "a long changed line\n".repeat(6000));
    const entries = app.manager.getEntries();
    const result = await app.diff();
    assert.equal(result.isError, false);
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.ok(Buffer.byteLength(text) < 53 * 1024);
    const output = (result.details as any).output;
    assert.equal(output.truncated, true);
    assert.equal(output.totalRepositories, 1);
    assert.equal((result.details as any).coverage, undefined);
    assert.ok(!output.fullOutputPath.startsWith(testWorkspace.cwd));
    const full = JSON.parse(await readFile(output.fullOutputPath, "utf8"));
    assert.equal(full.files[0].additions, 6000);
    assert.deepEqual(full.coverage, { searchDepth: 0, repositories: ["."] });
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
});

test("workspace queries filter exact repository-relative files and reject unsupported or unsafe requests", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "changed\n");
    await writeFile(join(testWorkspace.cwd, "new.txt"), "new\n");
    const filtered = await app.diff({ scope: "workspace", files: ["@notes.txt"] });
    assert.equal(filtered.isError, false);
    assert.deepEqual((filtered.details as any).files.map((file: any) => file.path), ["notes.txt"]);
    assert.deepEqual(((await app.diff({ files: ["not-present"] })).details as any).files, []);
    for (const path of ["../outside", "/absolute", ".git/config"]) {
      const invalid = await app.diff({ files: [path] });
      assert.equal(invalid.isError, true, path);
      assert.equal((invalid.details as any).code, "invalid_request");
    }
    const unsupported = await app.diff({ scope: "unknown" });
    assert.equal(unsupported.isError, true);
    assert.equal((unsupported.details as any).code, "unsupported_scope");
  } finally { dispose(app.session); }
});
