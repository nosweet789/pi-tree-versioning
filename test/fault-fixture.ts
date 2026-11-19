import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { Fixture } from "./harness.ts";

export function snapshotDirectory(workspace: Fixture, sessionId: string) {
  return join(workspace.agentDir, "tree-versioning", sessionId);
}

/** Only fixture setup knows the persistence encoding; tests assert public behavior. */
export async function checkpointArtifact(workspace: Fixture, sessionId: string, checkpointId: string) {
  const storage = snapshotDirectory(workspace, sessionId);
  for (const entry of await readdir(storage, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(storage, entry.name);
    let data;
    try { data = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    if (data?.checkpoint?.id === checkpointId) return path;
  }
  throw new Error("Checkpoint artifact not found for fault injection.");
}

async function sharedFileStateFixture(workspace: Fixture, sessionId: string, checkpointId: string) {
  const checkpoint = await checkpointArtifact(workspace, sessionId, checkpointId);
  const { integrity: _integrity, ...reference } = JSON.parse(await readFile(checkpoint, "utf8"));
  if (typeof reference.fileState?.digest !== "string") throw new Error("No shared file state found for fault injection.");
  const path = join(snapshotDirectory(workspace, sessionId), `file-state-${reference.fileState.digest}.json`);
  return { path, checkpoint, reference };
}

export async function sharedFileStateArtifact(workspace: Fixture, sessionId: string, checkpointId: string) {
  return (await sharedFileStateFixture(workspace, sessionId, checkpointId)).path;
}

export function capturePathsArtifact(workspace: Fixture, sessionId: string, checkpointId: string) {
  return join(snapshotDirectory(workspace, sessionId), `capture-paths-${checkpointId}.json`);
}

export async function damageSharedFileStateIdentity(workspace: Fixture, sessionId: string, checkpointId: string) {
  const path = await sharedFileStateArtifact(workspace, sessionId, checkpointId);
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...value, instanceId: randomUUID() }));
}

export function beforeSnapshotPublication(t: TestContext, artifact: "checkpoint" | "file state") {
  // Match only the selected publication, not temporary writes or capture I/O.
  const prefix = artifact === "checkpoint" ? "checkpoint-" : "file-state-";
  const link = fsPromises.link;
  let fault: { directory: string; run: () => Promise<void> } | undefined;
  const mocked = t.mock.method(fsPromises, "link", async (from: string, to: string) => {
    if (fault && dirname(to) === fault.directory && basename(to).startsWith(prefix)) {
      const run = fault.run;
      fault = undefined;
      await run();
    }
    return link(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return (directory: string, run: () => Promise<void>) => { fault = { directory, run }; };
}

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function snapshotEnvelope(value: object) { return JSON.stringify({ ...value, integrity: digest(value) }); }

export async function rewriteSharedFileState(workspace: Fixture, sessionId: string, checkpointId: string,
  edit: (files: Record<string, unknown>) => void) {
  const { path, checkpoint, reference } = await sharedFileStateFixture(workspace, sessionId, checkpointId);
  const data = JSON.parse(await readFile(path, "utf8"));
  edit(data.files);
  const fileDigest = digest(data.files);
  data.integrity = createHash("sha256").update(`${fileDigest}:${data.instanceId}`).digest("hex");
  reference.fileState = { digest: fileDigest, integrity: data.integrity };
  await writeFile(join(snapshotDirectory(workspace, sessionId), `file-state-${fileDigest}.json`), JSON.stringify(data));
  await writeFile(checkpoint, snapshotEnvelope(reference));
}

export async function damageCheckpoint(workspace: Fixture, sessionId: string, checkpointId: string, damage: "missing" | "corrupt") {
  const path = await checkpointArtifact(workspace, sessionId, checkpointId);
  if (damage === "missing") await rm(path);
  else await writeFile(path, "corrupt snapshot");
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
