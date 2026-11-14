import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Fixture } from "./harness.ts";

/** Pause one real Git scan, leaving subsequent host operations free to proceed. */
export async function pauseGitScan(workspace: Fixture) {
  const originalPath = process.env.PATH;
  const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const commands = join(workspace.root, "commands");
  const started = join(workspace.root, "scan-started");
  const released = join(workspace.root, "scan-released");
  await mkdir(commands);
  await writeFile(join(commands, "git"), `#!${process.execPath}
const { existsSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
let paused = false;
if (process.argv.includes("ls-files")) {
  try { mkdirSync(${JSON.stringify(started)}); paused = true; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
if (paused) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(released)})) Atomics.wait(pause, 0, 0, 10);
}
const result = spawnSync(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: "inherit" });
process.exitCode = result.status ?? 1;
`, { mode: 0o700 });
  process.env.PATH = commands + ":" + originalPath;
  return {
    async wait() {
      const signal = AbortSignal.timeout(4000);
      while (!existsSync(started)) await delay(5, undefined, { signal });
    },
    async release() {
      process.env.PATH = originalPath;
      await writeFile(released, "continue");
    },
  };
}
