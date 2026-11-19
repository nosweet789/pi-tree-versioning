import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Fixture } from "./harness.ts";

/** Intercept Git subprocesses; other calls use the original PATH. */
export async function interceptGit(workspace: Fixture, script: string) {
  const originalPath = process.env.PATH;
  const commands = await mkdtemp(join(workspace.root, "git-wrapper-"));
  await writeFile(join(commands, "git"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const status = (() => {
${script}
})();
process.exitCode = status ?? spawnSync("git", args, {
  env: { ...process.env, PATH: ${JSON.stringify(originalPath ?? "")} }, stdio: "inherit"
}).status ?? 1;
`, { mode: 0o700 });
  process.env.PATH = commands + delimiter + (originalPath ?? "");
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  };
}

/** Pause one matching Git call, leaving subsequent host operations free to proceed. */
export async function pauseGitScan(workspace: Fixture, match = ["ls-files"], skip = 0) {
  const started = join(workspace.root, "scan-started");
  const released = join(workspace.root, "scan-released");
  const restorePath = await interceptGit(workspace, `
const { existsSync, mkdirSync } = require("node:fs");
let paused = false;
if (${JSON.stringify(match)}.every(argument => args.includes(argument))) {
  for (let index = 0; index < ${skip}; index++) {
    try { mkdirSync(${JSON.stringify(started)} + "-" + index); return; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try { mkdirSync(${JSON.stringify(started)}); paused = true; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
if (paused) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(released)})) Atomics.wait(pause, 0, 0, 10);
}
`);
  return {
    async wait() {
      const signal = AbortSignal.timeout(4000);
      while (!existsSync(started)) await delay(5, undefined, { signal });
    },
    async release() {
      restorePath();
      await writeFile(released, "continue");
    },
  };
}
