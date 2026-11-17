import type { SessionEntry, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatPatch, structuredPatch } from "diff";
import { VersioningError, type ErrorCode } from "./errors.ts";
import { canonicalLocation, isWithin } from "./paths.ts";
import { discoverRepositories, isRepositoryScope, repositoryCoverage, validPath, workspaceRoot, workspaceScope, type RepositoryScope } from "./repositories.ts";

export interface SessionPosition {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  leafId: string | null;
  entries: readonly SessionEntry[];
}

interface ComparisonRequest { scope?: string; checkpointId?: string; files?: string[] }
export type RecordedDiff = Awaited<ReturnType<SessionFiles["diff"]>> | {
  status: "error"; checkpointId: string; code: ErrorCode;
};

type FileState = { kind: "file"; content: string; executable: boolean } |
  { kind: "symlink"; target: string; targetEncoding: "utf8" | "base64" };

interface FileSnapshot {
  version: 1 | 2;
  repositoryScope?: RepositoryScope;
  sessionId: string;
  workspaceRoot: string;
  files: Record<string, FileState>;
}

interface Snapshot extends FileSnapshot {
  baseline: { id: string; capturedAt: string; anchorId: string | null };
  priorEntryIds: string[];
  inheritedCheckpoints?: Checkpoint[];
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

function checksum(snapshot: FileSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function parseSnapshot(text: string, kind: "baseline"): Snapshot;
function parseSnapshot(text: string, kind: "checkpoint"): CheckpointSnapshot;
function parseSnapshot(text: string, kind: "baseline" | "checkpoint"): Snapshot | CheckpointSnapshot {
  const { integrity, ...value } = JSON.parse(text);
  if (integrity !== checksum(value as Snapshot) || ![1, 2].includes(value.version) ||
      (value.version === 2 ? !isRepositoryScope(value.repositoryScope) : value.repositoryScope !== undefined) ||
      typeof value.sessionId !== "string" || typeof value.workspaceRoot !== "string" ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files) ||
      (kind === "checkpoint" ? !isCheckpoint(value.checkpoint) :
        typeof value.baseline?.id !== "string" || typeof value.baseline?.capturedAt !== "string" ||
        !(value.baseline.anchorId === null || typeof value.baseline.anchorId === "string") ||
        !Array.isArray(value.priorEntryIds) || !value.priorEntryIds.every((id: unknown) => typeof id === "string") ||
        value.inheritedCheckpoints !== undefined && (!Array.isArray(value.inheritedCheckpoints) || !value.inheritedCheckpoints.every(isCheckpoint)))) {
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
    if (state.kind === "symlink" && (!bytes(state).length || bytes(state).includes(0))) {
      throw new Error("Invalid symbolic-link target");
    }
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length++) {
      if (Object.hasOwn(value.files, segments.slice(0, length).join("/"))) throw new Error("Conflicting snapshot paths");
    }
  }
  value.files = Object.assign(Object.create(null), value.files);
  return value as Snapshot | CheckpointSnapshot;
}

async function capture(root: string, repositories?: RepositoryScope, knownPaths: string[] = []): Promise<Record<string, FileState>> {
  try {
    const scope = await workspaceScope(root, repositories);
    await scope.assertOwnership(knownPaths);
    return await collect(root, scope);
  } catch (error) {
    throw new VersioningError("capture_failed", error instanceof Error ? error.message : String(error));
  }
}

async function collect(root: string, scope?: Awaited<ReturnType<typeof workspaceScope>>): Promise<Record<string, FileState>> {
  scope ??= await workspaceScope(root);
  const files: Record<string, FileState> = Object.create(null);
  for (const path of scope.paths) {
    const segments = path.split("/");
    if (!validPath(path)) continue;
    try {
      let parent = root;
      let blocked = false;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        const stat = await lstat(parent);
        if (!stat.isDirectory()) { blocked = true; break; }
      }
      if (blocked || await scope.excludes(path)) continue;
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
  await scope.verify();
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

function applySnapshot(root: string, current: Record<string, FileState>, target: Record<string, FileState>) {
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Workspace root changed before restoration.");
  const statAt = (path: string) => {
    try { return lstatSync(join(root, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const directories = new Set<string>();
  const inspectDirectory = (path: string) => {
    for (const name of readdirSync(join(root, path))) {
      const child = path + "/" + name;
      if (!validPath(child)) throw new Error(`Restore would remove protected content: ${child}`);
      const stat = statAt(child)!;
      if (stat.isDirectory()) inspectDirectory(child);
      else if (!(child in current) || child in target) throw new Error(`Restore would remove unmanaged content: ${child}`);
    }
    directories.add(path);
  };
  // Preflight topology before deleting anything, including ignored directory contents.
  for (const path of Object.keys(target)) {
    let parent = "";
    let parentNeedsCreation = false;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = parent ? parent + "/" + segment : segment;
      if (parent in target) throw new Error(`Conflicting snapshot paths: ${path}`);
      if (parentNeedsCreation) continue;
      const stat = statAt(parent);
      if (!stat) { parentNeedsCreation = true; continue; }
      if (stat.isDirectory()) continue;
      if (stat.isFile() && parent in current) { parentNeedsCreation = true; continue; }
      throw new Error(`Unsafe restore parent: ${path}`);
    }
    if (parentNeedsCreation) continue;
    const stat = statAt(path);
    if (stat?.isDirectory()) inspectDirectory(path);
    else if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported restore target: ${path}`);
  }
  // Check permissions for every planned mutation before writing in any repository.
  for (const path of new Set([...directories, ...Object.keys(current), ...Object.keys(target)])) {
    if (!directories.has(path) && JSON.stringify(current[path]) === JSON.stringify(target[path])) continue;
    let parent = dirname(join(root, path));
    while (true) {
      try { if (lstatSync(parent).isDirectory()) break; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      const next = dirname(parent);
      if (next === parent) throw new Error("No accessible restoration parent: " + path);
      parent = next;
    }
    accessSync(parent, constants.W_OK | constants.X_OK);
  }
  // The mutation window is synchronous: host navigation or runtime replacement cannot
  // interleave these writes. External concurrent filesystem writers are not supported.
  for (const path of Object.keys(current).sort((a, b) => b.split("/").length - a.split("/").length)) {
    if (!(path in target)) unlinkSync(join(root, path));
  }
  for (const directory of directories) rmdirSync(join(root, directory));
  for (const [path, state] of Object.entries(target)) {
    if (JSON.stringify(current[path]) === JSON.stringify(state)) continue;
    let parent = root;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      try { mkdirSync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!lstatSync(parent).isDirectory()) throw new Error(`Unsafe restore parent: ${path}`);
    }
    const absolute = join(root, path);
    // Never truncate an existing inode: it may be a hard link outside the workspace.
    try { unlinkSync(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (state.kind === "symlink") symlinkSync(bytes(state), absolute);
    else writeFileSync(absolute, bytes(state), { flag: "wx", mode: state.executable ? 0o755 : 0o644 });
  }
}

/** Owns file collection, persistence, history coverage, comparisons, restoration, and inheritance. */
export class SessionFiles {
  private forkAttempt?: { sessionId: string; token: string };

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

  private async readRegularFile(path: string) {
    if (!(await lstat(path)).isFile()) throw new Error("Stored data is not a regular file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Stored data is not a regular file");
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

  async prepareFork(position: SessionPosition, entryId: string, forkPosition: "before" | "at") {
    this.forkAttempt = undefined;
    await this.assertExternalPersistence(position, await workspaceRoot(position.cwd));
    if (!position.sessionFile) await rm(this.transferPath(undefined, position.cwd), { force: true });
    const token = randomUUID();
    const path = await this.storagePath(position.sessionId, true, "fork-" + token + ".json");
    await writeFile(path, JSON.stringify({ sessionId: position.sessionId, entryId, position: forkPosition }), { flag: "wx", mode: 0o600 });
    this.forkAttempt = { sessionId: position.sessionId, token };
  }

  async finishFork(position: SessionPosition, targetSessionFile?: string) {
    const attempt = this.forkAttempt;
    this.forkAttempt = undefined;
    if (!attempt || attempt.sessionId !== position.sessionId) return;
    const source = await this.storagePath(position.sessionId, false, "fork-" + attempt.token + ".json");
    const intent = JSON.parse(await this.readRegularFile(source));
    const destination = this.transferPath(targetSessionFile, position.cwd);
    const temporary = destination + "." + attempt.token + ".tmp";
    try {
      // Persist the settled source tree as well as intent. Ephemeral sessions have no
      // JSONL source, and the host mutates their manager after this shutdown hook.
      await writeFile(temporary, JSON.stringify({ source: position, intent, targetSessionFile }), { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      await rm(source);
    } finally { await rm(temporary, { force: true }); }
  }

  private transferPath(sessionFile: string | undefined, cwd: string) {
    // Native pi owns one active runtime per process. File-backed replacements have
    // a unique target path; an ephemeral replacement uses a one-shot process slot.
    const identity = sessionFile ?? JSON.stringify({ processId: process.pid, cwd });
    return join(this.storageDir, "transfer-" + createHash("sha256").update(identity).digest("hex") + ".json");
  }

  async initialize(position: SessionPosition, reason: SessionStartEvent["reason"] = "startup", searchDepth: (root: string) => number = () => 0) {
    const root = await workspaceRoot(position.cwd);
    await this.assertExternalPersistence(position, root);
    const fork = reason === "fork";
    // A replacement can fail before its origin marker is writable. Its durable
    // receipt still distinguishes it from a new session when later reopened.
    const receipt = reason !== "new" && (fork || position.sessionFile || reason === "reload") &&
      await lstat(this.transferPath(position.sessionFile, position.cwd)).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    let restore = false;
    if (fork || receipt) {
      await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.storageDir)).isDirectory()) throw new Error("Snapshot storage must not traverse symbolic links");
      // Record the origin before touching the child directory, which may be obstructed.
      // This also covers an empty native copy with no baseline association entry.
      await writeFile(this.path(position.sessionId, "") + ".origin.json", JSON.stringify({ inherited: true }), { flag: "wx", mode: 0o600 }).catch(error => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!await lstat(this.path(position.sessionId, "baseline.json")).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      })) {
        const restoreRequested = await this.inherit(position, root);
        restore = fork && restoreRequested;
      }
    }
    try {
      const existing = await this.load(position);
      return { baseline: existing.baseline, coverage: repositoryCoverage(existing.repositoryScope), created: !existing.inheritedCheckpoints && !fork && !this.hasBaselineRecord(position), workspaceRoot: root, restore };
    } catch (error) {
      if (!(error instanceof VersioningError) || error.code !== "no_baseline") throw error;
    }
    const hasConversation = position.entries.some(entry => entry.type === "message" && entry.message.role !== "system" || entry.type === "custom_message");
    let repositoryScope: RepositoryScope;
    try { repositoryScope = await discoverRepositories(root, searchDepth(root)); }
    catch (error) { throw new VersioningError("capture_failed", String(error)); }
    const snapshot: Snapshot = {
      version: 2, repositoryScope, sessionId: position.sessionId, workspaceRoot: root,
      baseline: {
        id: randomUUID(), capturedAt: new Date().toISOString(),
        anchorId: hasConversation ? position.leafId : null,
      },
      files: await capture(root, repositoryScope),
      priorEntryIds: hasConversation ? position.entries.map(entry => entry.id) : [],
    };
    try {
      const path = await this.storagePath(position.sessionId, true);
      try { await this.publishSnapshot(path, snapshot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.load(position);
        return { baseline: existing.baseline, coverage: repositoryCoverage(existing.repositoryScope), created: !this.hasBaselineRecord(position), workspaceRoot: root, restore: false };
      }
      return { baseline: snapshot.baseline, coverage: repositoryCoverage(snapshot.repositoryScope), created: true, workspaceRoot: root, restore: false };
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    }
  }

  private async inherit(position: SessionPosition, root: string) {
    const receipt = this.transferPath(position.sessionFile, position.cwd);
    const { source, intent, targetSessionFile } = JSON.parse(await this.readRegularFile(receipt)) as {
      source: SessionPosition; intent: { sessionId: string; entryId: string; position: "before" | "at" }; targetSessionFile?: string;
    };
    // Consume before copying: a failed operation must not supply intent to a later
    // ephemeral replacement, and an undeletable stale receipt is never trusted.
    await rm(receipt);
    if (!source || typeof source.sessionId !== "string" || typeof source.cwd !== "string" ||
        !Array.isArray(source.entries) || source.sessionId === position.sessionId ||
        targetSessionFile !== position.sessionFile || intent?.sessionId !== source.sessionId) {
      throw new VersioningError("snapshot_unavailable", "Invalid source session identity.");
    }
    const sourceEntries = new Map(source.entries.map(entry => [entry.id, entry]));
    const childEntries = new Map(position.entries.map(entry => [entry.id, entry]));
    const selected = sourceEntries.get(intent.entryId);
    if (!selected || !["before", "at"].includes(intent.position) ||
        intent.position === "before" && (selected.type !== "message" || selected.message.role !== "user")) {
      throw new VersioningError("snapshot_unavailable", "Invalid fork intent.");
    }
    const target = intent.position === "at" ? selected.id : selected.parentId;
    const sourceBranch = this.branchAt(source, target);
    const expected = sourceBranch.filter(id => sourceEntries.get(id)!.type !== "label");
    const actual = this.branchAt(position, position.leafId).filter(id => childEntries.get(id)!.type !== "label");
    const startupEntries = actual.slice(expected.length).map(id => childEntries.get(id)!);
    if (JSON.stringify(expected) !== JSON.stringify(actual.slice(0, expected.length)) ||
        startupEntries.some(entry => entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
      throw new VersioningError("snapshot_unavailable", "The copied native history does not match the fork destination.");
    }
    const baseline = await this.load(source);
    if (baseline.workspaceRoot !== root) throw new VersioningError("workspace_mismatch", "Cannot inherit history across workspaces.");
    const copiedNodes = new Set(position.entries.map(entry => entry.id));
    const copiedNode = (nodeId: string) => {
      if (copiedNodes.has(nodeId)) return nodeId;
      const node = sourceEntries.get(nodeId);
      if (node?.type !== "label" || !sourceBranch.includes(node.id)) return undefined;
      // Pi removes labels from the copied chain and recreates them at its end.
      // Prefer the first retained descendant (often our association entry), never
      // move a saved state backwards to an earlier conversation message.
      return sourceBranch.slice(sourceBranch.indexOf(node.id) + 1).find(id => copiedNodes.has(id)) ??
        position.entries.find(entry => entry.type === "label" && entry.targetId === node.targetId && entry.label === node.label)?.id;
    };
    const anchorId = baseline.baseline.anchorId !== null && this.baselineCovers(baseline, sourceBranch)
      ? copiedNode(baseline.baseline.anchorId) ?? baseline.baseline.anchorId : baseline.baseline.anchorId;
    const checkpoints: CheckpointSnapshot[] = [];
    for (const record of this.checkpointRecords(source, baseline)) {
      const nodeId = copiedNode(record.nodeId);
      if (nodeId) {
        const snapshot = await this.loadCheckpoint(source, record, root, baseline.repositoryScope);
        checkpoints.push({ ...snapshot, checkpoint: { id: record.id, capturedAt: record.capturedAt, nodeId } });
      }
    }
    const inheritedCheckpoints = checkpoints.map(snapshot => snapshot.checkpoint);
    const destination = await this.storagePath(position.sessionId, true);
    const staging = await mkdtemp(join(this.storageDir, ".inherit-"));
    try {
      for (const snapshot of checkpoints) {
        await this.publishSnapshot(join(staging, "checkpoint-" + snapshot.checkpoint.id + ".json"),
          { ...snapshot, sessionId: position.sessionId });
      }
      const inheritedBaseline: Snapshot = { ...baseline, sessionId: position.sessionId,
        baseline: { ...baseline.baseline, anchorId }, inheritedCheckpoints };
      await this.publishSnapshot(join(staging, "baseline.json"), inheritedBaseline);
      // Publish the complete independent history at once, never a partial baseline.
      await rename(staging, dirname(destination));
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    } finally { await rm(staging, { recursive: true, force: true }); }
    return intent.position === "before";
  }

  private async load(position: SessionPosition): Promise<Snapshot> {
    let snapshot: Snapshot;
    try {
      const path = await this.storagePath(position.sessionId);
      snapshot = parseSnapshot(await this.readRegularFile(path), "baseline");
    } catch (error) {
      const inherited = await lstat(this.path(position.sessionId, "") + ".origin.json").catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      throw new VersioningError(
        (error as NodeJS.ErrnoException).code === "ENOENT" && !this.hasBaselineRecord(position) && !inherited ? "no_baseline" : "snapshot_unavailable",
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
    const previous = this.nearestCheckpoint(this.checkpointRecords(position, baseline), this.branchAt(position, position.leafId));
    let known: FileSnapshot = baseline;
    if (previous) {
      try { known = await this.loadCheckpoint(position, previous, baseline.workspaceRoot, baseline.repositoryScope); }
      catch (error) {
        // A missing predecessor prevents its diff, not an independent capture of disk.
        if (!(error instanceof VersioningError) || error.code !== "snapshot_unavailable") throw error;
      }
    }
    const snapshot: CheckpointSnapshot = {
      version: baseline.version, ...(baseline.repositoryScope ? { repositoryScope: baseline.repositoryScope } : {}),
      sessionId: position.sessionId, workspaceRoot: baseline.workspaceRoot,
      checkpoint, files: await capture(baseline.workspaceRoot, baseline.repositoryScope, Object.keys(known.files)),
    };
    try {
      const path = await this.storagePath(position.sessionId, false, "checkpoint-" + checkpoint.id + ".json");
      await this.publishSnapshot(path, snapshot);
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    }
    let comparison: RecordedDiff;
    try { comparison = await this.compare(position, { scope: "turn" }, snapshot); }
    catch (error) {
      comparison = { status: "error", checkpointId: checkpoint.id,
        code: error instanceof VersioningError ? error.code : "query_failed" };
    }
    return { checkpoint, comparison };
  }

  private checkpointRecords(position: SessionPosition, baseline: Snapshot): Checkpoint[] {
    const inherited = new Map((baseline.inheritedCheckpoints ?? []).map(record => [record.id, record]));
    const records = position.entries.filter(entry => entry.type === "custom" && entry.customType === "tree-versioning.checkpoint").map(entry => {
      const data = entry.type === "custom" ? entry.data : undefined;
      if (!isCheckpoint(data)) throw new VersioningError("snapshot_unavailable", "Invalid checkpoint association.");
      // Keep copied semantic entries intact; the child manifest owns rebinding of
      // native label IDs that the host removed and recreated during copying.
      const record = inherited.get(data.id) ?? data;
      if (record.capturedAt !== data.capturedAt || !(inherited.has(data.id) && record.nodeId === entry.id ||
          entry.parentId !== null && this.branchAt(position, entry.parentId).includes(record.nodeId))) {
        throw new VersioningError("snapshot_unavailable", "Invalid checkpoint association.");
      }
      return record;
    });
    const merged = new Map(records.map(record => [record.id, record]));
    for (const record of baseline.inheritedCheckpoints ?? []) {
      const existing = merged.get(record.id);
      if (!position.entries.some(entry => entry.id === record.nodeId) || existing &&
          (existing.nodeId !== record.nodeId || existing.capturedAt !== record.capturedAt)) {
        throw new VersioningError("snapshot_unavailable", "Invalid inherited checkpoint association.");
      }
      merged.set(record.id, record);
    }
    return [...merged.values()];
  }

  private async loadCheckpoint(position: SessionPosition, checkpoint: Checkpoint, root: string, scope?: RepositoryScope) {
    try {
      const path = await this.storagePath(position.sessionId, false, "checkpoint-" + checkpoint.id + ".json");
      const snapshot = parseSnapshot(await this.readRegularFile(path), "checkpoint");
      if (snapshot.sessionId !== position.sessionId || snapshot.workspaceRoot !== root ||
          snapshot.checkpoint.id !== checkpoint.id || snapshot.checkpoint.nodeId !== checkpoint.nodeId ||
          snapshot.checkpoint.capturedAt !== checkpoint.capturedAt ||
          JSON.stringify(snapshot.repositoryScope) !== JSON.stringify(scope)) {
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
    const records = this.checkpointRecords(position, snapshot);
    const checkpoints: ReturnType<SessionFiles["checkpointEndpoint"]>[] = [];
    for (const record of records) {
      checkpoints.push(this.checkpointEndpoint(await this.loadCheckpoint(position, record, snapshot.workspaceRoot, snapshot.repositoryScope)));
    }
    const branch = this.branchAt(position, position.leafId);
    const current = this.nearestCheckpoint(checkpoints, branch);
    return {
      status: "ok" as const, sessionId: position.sessionId, workspaceRoot: snapshot.workspaceRoot,
      coverage: repositoryCoverage(snapshot.repositoryScope),
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

  async restore(position: SessionPosition, stillCurrent: () => boolean) {
    const baseline = await this.load(position);
    await this.assertExternalPersistence(position, baseline.workspaceRoot);
    const branch = this.branchAt(position, position.leafId);
    const checkpoint = this.nearestCheckpoint(this.checkpointRecords(position, baseline), branch);
    if (!checkpoint && !this.baselineCovers(baseline, branch)) {
      throw new VersioningError("no_baseline", "No saved file history covers the navigation destination.");
    }
    const snapshot = checkpoint ? await this.loadCheckpoint(position, checkpoint, baseline.workspaceRoot, baseline.repositoryScope) : baseline;
    const root = snapshot.workspaceRoot;
    try {
      const scope = await workspaceScope(root, snapshot.repositoryScope);
      await scope.assertRestorable(Object.keys(snapshot.files));
      const current = await collect(root, scope);
      if (!stillCurrent()) throw new VersioningError("restore_superseded", "The restore destination is no longer current.");
      applySnapshot(root, current, snapshot.files);
    } catch (error) {
      if (error instanceof VersioningError) throw error;
      throw new VersioningError("restore_failed", String(error));
    }
    return checkpoint ? this.checkpointEndpoint(snapshot as CheckpointSnapshot) : this.baselineEndpoint(baseline);
  }

  async diff(position: SessionPosition, request: ComparisonRequest = {}) {
    return this.compare(position, request);
  }

  private async compare(position: SessionPosition, request: ComparisonRequest, recorded?: CheckpointSnapshot) {
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
    const records = this.checkpointRecords(position, snapshot);
    const currentBranch = this.branchAt(position, position.leafId);
    const checkpoint = recorded?.checkpoint ?? (checkpointId === undefined ? this.nearestCheckpoint(records, currentBranch) : records.find(record => record.id === checkpointId));
    if (scope === "turn" && !checkpoint) {
      throw new VersioningError("no_checkpoint", "No recorded round matches the requested checkpoint or current ancestry.");
    }
    const baselineAt = (branch: string[]) => {
      if (!this.baselineCovers(snapshot, branch)) throw new VersioningError("no_baseline", "No baseline covers the requested session position.");
      return { endpoint: this.baselineEndpoint(snapshot), files: snapshot.files };
    };
    const saved = async (record: Checkpoint) => {
      const savedSnapshot = await this.loadCheckpoint(position, record, snapshot.workspaceRoot, snapshot.repositoryScope);
      return { endpoint: this.checkpointEndpoint(savedSnapshot), files: savedSnapshot.files };
    };
    const branch = checkpoint ? this.branchAt(position, checkpoint.nodeId) : currentBranch;
    const target = recorded ? { endpoint: this.checkpointEndpoint(recorded), files: recorded.files } :
      checkpoint ? await saved(checkpoint) : baselineAt(branch);
    const previous = scope === "turn" ? this.nearestCheckpoint(records, branch.slice(0, -1)) : undefined;
    const source = scope === "workspace" ? target : scope === "turn" && previous ? await saved(previous) : baselineAt(branch);
    const current = scope === "workspace" ? await capture(snapshot.workspaceRoot, snapshot.repositoryScope, Object.keys(source.files)) : target.files;
    const files = [];
    for (const path of [...new Set([...Object.keys(source.files), ...Object.keys(current)])].sort()) {
      if (selected && !selected.has(path)) continue;
      const before = source.files[path];
      const after = current[path];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      files.push(compare(path, before, after));
    }
    return {
      status: "ok" as const, scope, coverage: repositoryCoverage(snapshot.repositoryScope),
      from: source.endpoint,
      to: scope === "workspace" ? { kind: "workspace" as const, workspaceRoot: snapshot.workspaceRoot } : target.endpoint,
      files,
    };
  }
}
