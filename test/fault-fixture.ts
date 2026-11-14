import fs from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Fixture } from "./harness.ts";

/** Only fault targeting knows the persistence encoding; tests assert public behavior. */
export async function damageCheckpoint(workspace: Fixture, sessionId: string, checkpointId: string, damage: "missing" | "corrupt") {
  const storage = join(workspace.agentDir, "tree-versioning", sessionId);
  for (const entry of await readdir(storage, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(storage, entry.name);
    let data;
    try { data = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    if (data?.checkpoint?.id !== checkpointId) continue;
    if (damage === "missing") await rm(path);
    else await writeFile(path, "corrupt snapshot");
    return;
  }
  throw new Error("Checkpoint artifact not found for fault injection.");
}

export function failWorkspaceWrite(t: TestContext, path: string) {
  const write = fs.writeFileSync;
  let injected = false;
  const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === path) {
      injected = true;
      throw Object.assign(new Error("Simulated disk write failure"), { code: "EIO" });
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return () => injected;
}
