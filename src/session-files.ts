import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { formatPatch, structuredPatch } from "diff";
import { VersioningError } from "./errors.ts";
import { canonicalLocation, isWithin } from "./paths.ts";

const exec = promisify(execFile);

export interface SessionPosition {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  leafId: string | null;
  entries: readonly SessionEntry[];
}

type FileState = { kind: "file"; content: string; executable: boolean } |
  { kind: "symlink"; target: string; targetEncoding: "utf8" | "base64" };

interface FileSnapshot {
  version: 1;
  sessionId: string;
  workspaceRoot: string;
  files: Record<string, FileState>;
}

interface Snapshot extends FileSnapshot {
  baseline: { id: string; capturedAt: string; anchorId: string | null };
  priorEntryIds: string[];
}

interface Checkpoint {
  id: string;
  capturedAt: string;
  nodeId: string;
}

interface CheckpointSnapshot extends FileSnapshot {
  checkpoint: Checkpoint;
}

function isCheckpoint(value: unknown): value is Checkpoint {
  const checkpoint = value as Checkpoint | undefined;
  return !!checkpoint && typeof checkpoint.id === "string" && /^[a-zA-Z0-9_-]+$/.test(checkpoint.id) &&
    typeof checkpoint.nodeId === "string" && typeof checkpoint.capturedAt === "string";
}

function validPath(path: string): boolean {
  return !path.includes("\0") && !isAbsolute(path) &&
    !(sep === "\\" && (path.includes("\\") || /^[a-z]:/i.test(path))) &&
    !path.split("/").some(segment => ["", ".", "..", ".git"].includes(segment.toLowerCase()));
}

function checksum(snapshot: FileSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function parseSnapshot(text: string, kind: "baseline"): Snapshot;
function parseSnapshot(text: string, kind: "checkpoint"): CheckpointSnapshot;
function parseSnapshot(text: string, kind: "baseline" | "checkpoint"): Snapshot | CheckpointSnapshot {
  const { integrity, ...value } = JSON.parse(text);
  if (integrity !== checksum(value as Snapshot) || value.version !== 1 ||
      typeof value.sessionId !== "string" || typeof value.workspaceRoot !== "string" ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files) ||
      (kind === "checkpoint" ? !isCheckpoint(value.checkpoint) :
        typeof value.baseline?.id !== "string" || typeof value.baseline?.capturedAt !== "string" ||
        !(value.baseline.anchorId === null || typeof value.baseline.anchorId === "string") ||
        !Array.isArray(value.priorEntryIds) || !value.priorEntryIds.every((id: unknown) => typeof id === "string"))) {
    throw new Error("Invalid snapshot data or integrity checksum");
  }
  for (const [path, state] of Object.entries(value.files) as [string, FileState][]) {
    if (!validPath(path) || !state ||
        !(state.kind === "file" && typeof state.content === "string" && typeof state.executable === "boolean" &&
          Buffer.from(state.content, "base64").toString("base64") === state.content ||
          state.kind === "symlink" && typeof state.target === "string" &&
          (state.targetEncoding === "utf8" && !state.target.includes("\0") ||
           state.targetEncoding === "base64" && Buffer.from(state.target, "base64").toString("base64") === state.target))) {
      throw new Error("Invalid snapshot file state");
    }
  }
  value.files = Object.assign(Object.create(null), value.files);
  return value as Snapshot | CheckpointSnapshot;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete (environment as NodeJS.ProcessEnv)[key];
  }
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    env: environment, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
  });
  if (!isUtf8(stdout)) throw new Error("Git returned paths that are not valid UTF-8");
  return stdout.toString("utf8");
}

async function workspaceRoot(cwd: string): Promise<string> {
  const output = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return realpath(output.replace(/\r?\n$/, ""));
}

async function capture(root: string): Promise<Record<string, FileState>> {
  try { return await collect(root); }
  catch (error) {
    throw new VersioningError("capture_failed", error instanceof Error ? error.message : String(error));
  }
}

async function collect(root: string): Promise<Record<string, FileState>> {
  const tracked = await git(root, ["ls-files", "--stage", "-z"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const administrativePaths = await Promise.all(["--absolute-git-dir", "--git-common-dir"].map(async flag => {
    const output = await git(root, ["rev-parse", "--path-format=absolute", flag]);
    return relative(root, await realpath(output.replace(/\r?\n$/, "")));
  }));
  const excluded = administrativePaths.filter(path => path !== ".." && !path.startsWith("../") && !isAbsolute(path));
  const submodules: string[] = [];
  const paths = new Set(untracked.split("\0").filter(Boolean));
  for (const record of tracked.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    const path = record.slice(separator + 1);
    if (record.startsWith("160000 ")) submodules.push(path);
    else paths.add(path);
  }
  const files: Record<string, FileState> = Object.create(null);
  for (const path of paths) {
    const segments = path.split("/");
    if (!validPath(path)) continue;
    if ([...submodules, ...excluded].some(exclusion => path === exclusion || path.startsWith(exclusion + "/"))) continue;
    try {
      let parent = root;
      let blocked = false;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        const stat = await lstat(parent);
        if (!stat.isDirectory()) { blocked = true; break; }
      }
      if (blocked) continue;
      const absolutePath = join(root, path);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        const targetBytes = await readlink(absolutePath, { encoding: "buffer" });
        const targetEncoding = isUtf8(targetBytes) ? "utf8" : "base64";
        files[path] = { kind: "symlink", target: targetBytes.toString(targetEncoding), targetEncoding };
      } else if (stat.isFile()) {
        const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await handle.stat()).isFile()) throw new Error(`File changed type during collection: ${path}`);
          files[path] = { kind: "file", content: (await handle.readFile()).toString("base64"), executable: (stat.mode & 0o111) !== 0 };
        } finally { await handle.close(); }
      } else if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${path}`);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return files;
}

function bytes(state: FileState | undefined): Buffer {
  return state?.kind === "file" ? Buffer.from(state.content, "base64") : Buffer.from(state?.target ?? "", state?.targetEncoding ?? "utf8");
}

function describe(state: FileState | undefined) {
  if (!state) return null;
  return state.kind === "symlink" ? state : { kind: state.kind, size: bytes(state).length, executable: state.executable };
}

function compare(path: string, before: FileState | undefined, after: FileState | undefined) {
  const oldBytes = bytes(before);
  const newBytes = bytes(after);
  const binary = oldBytes.includes(0) || newBytes.includes(0) || !isUtf8(oldBytes) || !isUtf8(newBytes);
  const patch = binary ? undefined : structuredPatch("a/" + path, "b/" + path, oldBytes.toString("utf8"), newBytes.toString("utf8"));
  return {
    path,
    status: before === undefined ? "added" : after === undefined ? "deleted" : before.kind !== after.kind ? "type_changed" : "modified",
    before: describe(before), after: describe(after), binary,
    additions: patch?.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("+")).length, 0) ?? null,
    deletions: patch?.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("-")).length, 0) ?? null,
    ...(patch ? { patch: formatPatch(patch) } : {}),
  };
}

/** Owns file collection, persistence, history coverage, and comparisons. */
export class SessionFiles {
  constructor(private readonly storageDir: string) {}

  private path(sessionId: string, filename: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session identity");
    return join(this.storageDir, sessionId, filename);
  }

  private async storagePath(sessionId: string, create = false, filename = "baseline.json"): Promise<string> {
    const path = this.path(sessionId, filename);
    for (const directory of [this.storageDir, dirname(path)]) {
      try { await lstat(directory); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      if (!(await lstat(directory)).isDirectory()) throw new Error("Snapshot storage must not traverse symbolic links");
    }
    return path;
  }

  private async readSnapshot(path: string) {
    if (!(await lstat(path)).isFile()) throw new Error("Snapshot is not a regular file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Snapshot is not a regular file");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }

  private async publishSnapshot(path: string, snapshot: FileSnapshot) {
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ ...snapshot, integrity: checksum(snapshot) }), { mode: 0o600, flag: "wx" });
      // Immutable publication never overwrites another snapshot.
      await link(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private hasBaselineRecord(position: SessionPosition) {
    return position.entries.some(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline");
  }

  private async assertExternalPersistence(position: SessionPosition, root: string) {
    const canonicalStorage = await canonicalLocation(this.storageDir);
    if (isWithin(root, canonicalStorage) || position.sessionFile && isWithin(root, await canonicalLocation(position.sessionFile))) {
      throw new VersioningError("storage_failed", "Snapshot storage and session persistence must be outside the managed workspace.");
    }
  }

  async initialize(position: SessionPosition) {
    const root = await workspaceRoot(position.cwd);
    await this.assertExternalPersistence(position, root);
    try {
      const existing = await this.load(position);
      return { baseline: existing.baseline, created: !this.hasBaselineRecord(position), workspaceRoot: root };
    } catch (error) {
      if (!(error instanceof VersioningError) || error.code !== "no_baseline") throw error;
    }
    const hasConversation = position.entries.some(entry => entry.type === "message" && entry.message.role !== "system" || entry.type === "custom_message");
    const snapshot: Snapshot = {
      version: 1, sessionId: position.sessionId, workspaceRoot: root,
      baseline: {
        id: randomUUID(), capturedAt: new Date().toISOString(),
        anchorId: hasConversation ? position.leafId : null,
      },
      files: await capture(root),
      priorEntryIds: hasConversation ? position.entries.map(entry => entry.id) : [],
    };
    try {
      const path = await this.storagePath(position.sessionId, true);
      try { await this.publishSnapshot(path, snapshot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return { baseline: (await this.load(position)).baseline, created: !this.hasBaselineRecord(position), workspaceRoot: root };
      }
      return { baseline: snapshot.baseline, created: true, workspaceRoot: root };
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    }
  }

  private async load(position: SessionPosition): Promise<Snapshot> {
    let snapshot: Snapshot;
    try {
      const path = await this.storagePath(position.sessionId);
      snapshot = parseSnapshot(await this.readSnapshot(path), "baseline");
    } catch (error) {
      throw new VersioningError(
        (error as NodeJS.ErrnoException).code === "ENOENT" && !this.hasBaselineRecord(position) ? "no_baseline" : "snapshot_unavailable",
        "The session baseline is missing, unreadable, or corrupt.",
      );
    }
    if (snapshot.sessionId !== position.sessionId || snapshot.workspaceRoot !== await workspaceRoot(position.cwd)) {
      throw new VersioningError("workspace_mismatch", "Snapshot session or workspace identity does not match.");
    }
    return snapshot;
  }

  async record(position: SessionPosition) {
    const baseline = await this.load(position);
    await this.assertExternalPersistence(position, baseline.workspaceRoot);
    if (!position.leafId) throw new VersioningError("capture_failed", "The round has no native session node.");
    const checkpoint: Checkpoint = { id: randomUUID(), nodeId: position.leafId, capturedAt: new Date().toISOString() };
    const snapshot: CheckpointSnapshot = {
      version: 1, sessionId: position.sessionId, workspaceRoot: baseline.workspaceRoot,
      checkpoint, files: await capture(baseline.workspaceRoot),
    };
    try {
      const path = await this.storagePath(position.sessionId, false, "checkpoint-" + checkpoint.id + ".json");
      await this.publishSnapshot(path, snapshot);
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    }
    return checkpoint;
  }

  private checkpointRecords(position: SessionPosition): Checkpoint[] {
    return position.entries.filter(entry => entry.type === "custom" && entry.customType === "tree-versioning.checkpoint").map(entry => {
      const data = entry.type === "custom" ? entry.data : undefined;
      if (!isCheckpoint(data) || entry.parentId === null || !this.branchAt(position, entry.parentId).includes(data.nodeId)) {
        throw new VersioningError("snapshot_unavailable", "Invalid checkpoint association.");
      }
      return data;
    });
  }

  private async loadCheckpoint(position: SessionPosition, checkpoint: Checkpoint, root: string) {
    try {
      const path = await this.storagePath(position.sessionId, false, "checkpoint-" + checkpoint.id + ".json");
      const snapshot = parseSnapshot(await this.readSnapshot(path), "checkpoint");
      if (snapshot.sessionId !== position.sessionId || snapshot.workspaceRoot !== root ||
          snapshot.checkpoint.id !== checkpoint.id || snapshot.checkpoint.nodeId !== checkpoint.nodeId ||
          snapshot.checkpoint.capturedAt !== checkpoint.capturedAt) {
        throw new Error("Checkpoint identity or association does not match.");
      }
      return snapshot;
    } catch (error) {
      throw new VersioningError("snapshot_unavailable", `Checkpoint ${checkpoint.id} is missing, unreadable, or corrupt. ${String(error)}`);
    }
  }

  private baselineEndpoint(snapshot: Snapshot) {
    return { kind: "baseline" as const, sessionId: snapshot.sessionId, workspaceRoot: snapshot.workspaceRoot, ...snapshot.baseline };
  }

  private checkpointEndpoint(snapshot: CheckpointSnapshot) {
    return { kind: "checkpoint" as const, sessionId: snapshot.sessionId, workspaceRoot: snapshot.workspaceRoot, ...snapshot.checkpoint };
  }

  private baselineCovers(snapshot: Snapshot, branchIds: string[]) {
    const anchor = snapshot.baseline.anchorId;
    const anchorIndex = anchor === null ? -1 : branchIds.indexOf(anchor);
    const priorEntries = new Set(snapshot.priorEntryIds);
    return !(anchor !== null && anchorIndex === -1 ||
      branchIds.slice(anchorIndex + 1).some(id => priorEntries.has(id)));
  }

  private nearestCheckpoint<T extends Checkpoint>(checkpoints: readonly T[], branch: readonly string[]): T | undefined {
    const byNode = new Map(checkpoints.map(checkpoint => [checkpoint.nodeId, checkpoint]));
    for (let index = branch.length - 1; index >= 0; index--) {
      const checkpoint = byNode.get(branch[index]);
      if (checkpoint) return checkpoint;
    }
    return undefined;
  }

  async checkpoints(position: SessionPosition) {
    const snapshot = await this.load(position);
    const records = this.checkpointRecords(position);
    const checkpoints: ReturnType<SessionFiles["checkpointEndpoint"]>[] = [];
    for (const record of records) {
      checkpoints.push(this.checkpointEndpoint(await this.loadCheckpoint(position, record, snapshot.workspaceRoot)));
    }
    const branch = this.branchAt(position, position.leafId);
    const current = this.nearestCheckpoint(checkpoints, branch);
    return {
      status: "ok" as const, sessionId: position.sessionId, workspaceRoot: snapshot.workspaceRoot,
      baseline: this.baselineEndpoint(snapshot), checkpoints,
      current: { nodeId: position.leafId, snapshot: current ?? (this.baselineCovers(snapshot, branch) ? this.baselineEndpoint(snapshot) : null) },
    };
  }

  private branchAt(position: SessionPosition, nodeId: string | null): string[] {
    const parents = new Map(position.entries.map(entry => [entry.id, entry.parentId]));
    const branch: string[] = [];
    const seen = new Set<string>();
    let current: string | null = nodeId;
    while (current !== null) {
      if (seen.has(current) || !parents.has(current)) throw new VersioningError("snapshot_unavailable", "Invalid native ancestry.");
      seen.add(current);
      branch.push(current);
      current = parents.get(current)!;
    }
    return branch.reverse();
  }

  async diff(position: SessionPosition, request: { scope?: string; checkpointId?: string; files?: string[] } = {}) {
    const { scope = "workspace", checkpointId, files: requestedFiles } = request;
    if (scope !== "workspace" && scope !== "turn" && scope !== "session") {
      throw new VersioningError("unsupported_scope", "Expected workspace, turn, or session scope.");
    }
    if (checkpointId !== undefined && scope !== "turn") {
      throw new VersioningError("invalid_request", "checkpointId is only valid for turn comparisons.");
    }
    const selected = requestedFiles === undefined ? undefined : new Set(requestedFiles.map(path => {
      const relative = path.startsWith("@") ? path.slice(1) : path;
      if (!validPath(relative)) {
        throw new VersioningError("invalid_request", "File filters must be safe repository-relative paths.");
      }
      return relative;
    }));
    const snapshot = await this.load(position);
    const records = this.checkpointRecords(position);
    const currentBranch = this.branchAt(position, position.leafId);
    const checkpoint = checkpointId === undefined ? this.nearestCheckpoint(records, currentBranch) : records.find(record => record.id === checkpointId);
    if (scope === "turn" && !checkpoint) {
      throw new VersioningError("no_checkpoint", "No recorded round matches the requested checkpoint or current ancestry.");
    }
    const baselineAt = (branch: string[]) => {
      if (!this.baselineCovers(snapshot, branch)) throw new VersioningError("no_baseline", "No baseline covers the requested session position.");
      return { endpoint: this.baselineEndpoint(snapshot), files: snapshot.files };
    };
    const saved = async (record: Checkpoint) => {
      const savedSnapshot = await this.loadCheckpoint(position, record, snapshot.workspaceRoot);
      return { endpoint: this.checkpointEndpoint(savedSnapshot), files: savedSnapshot.files };
    };
    const branch = checkpoint ? this.branchAt(position, checkpoint.nodeId) : currentBranch;
    const target = checkpoint ? await saved(checkpoint) : baselineAt(branch);
    const previous = scope === "turn" ? this.nearestCheckpoint(records, branch.slice(0, -1)) : undefined;
    const source = scope === "workspace" ? target : scope === "turn" && previous ? await saved(previous) : baselineAt(branch);
    const current = scope === "workspace" ? await capture(snapshot.workspaceRoot) : target.files;
    const files = [];
    for (const path of [...new Set([...Object.keys(source.files), ...Object.keys(current)])].sort()) {
      if (selected && !selected.has(path)) continue;
      const before = source.files[path];
      const after = current[path];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      files.push(compare(path, before, after));
    }
    return {
      status: "ok" as const, scope,
      from: source.endpoint,
      to: scope === "workspace" ? { kind: "workspace" as const, workspaceRoot: snapshot.workspaceRoot } : target.endpoint,
      files,
    };
  }
}
