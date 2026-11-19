import type { CustomEntry, SessionEntry, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { isUtf8 } from "node:buffer";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatPatch, structuredPatch } from "diff";
import { VersioningError, type ErrorCode } from "./errors.ts";
import { canonicalLocation, isWithin } from "./paths.ts";
import { discoverRepositories, findWorkspaceRoot, isRepositoryScope, repositoryCoverage, validPath, workspaceRoot, workspaceScope, type RepositoryScope } from "./repositories.ts";

export interface SessionPosition {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  leafId: string | null;
  entries: readonly SessionEntry[];
}

interface ForkIntent {
  sessionId: string;
  entryId: string;
  position: "before" | "at";
}

interface ForkTransfer {
  source: SessionPosition;
  intent: ForkIntent;
  targetSessionFile?: string;
}

type ForkAttempt =
  | { kind: "no-history"; sessionId: string }
  | { kind: "transfer"; sessionId: string; token: string };

type TransientFork =
  | { kind: "no-history"; sourceFile?: string; targetFile?: string }
  | { kind: "ephemeral"; transfer: ForkTransfer; childSessionId?: string };

// Pi reloads the extension module with each replacement. Only file-backed history
// needs a durable receipt; skipped and ephemeral forks can hand off in this process.
const forkHandoffsKey = Symbol.for("pi-tree-versioning.fork-handoffs");
const processState = globalThis as typeof globalThis & { [forkHandoffsKey]?: Map<string, TransientFork> };
const forkHandoffs = processState[forkHandoffsKey] ??= new Map<string, TransientFork>();

interface ComparisonRequest { scope?: string; checkpointId?: string; files?: string[] }
export type RecordedDiff = Awaited<ReturnType<SessionFiles["diff"]>> | {
  status: "error"; checkpointId: string; code: ErrorCode;
};
export const checkpointEntryType = "tree-versioning.checkpoint";
export type CheckpointEntryData = Checkpoint & { diff?: unknown };
export interface RoundDiffPreview { nodeId: string; diff: unknown };

function unavailableRoundDiff(checkpointId: string, error: unknown): RecordedDiff {
  return { status: "error", checkpointId, code: error instanceof VersioningError ? error.code : "query_failed" };
}

function savedRoundEndpoint(data: CheckpointEntryData | undefined) {
  const diff = data?.diff as Partial<RecordedDiff> | undefined;
  if (diff?.status === "ok" && diff.scope === "turn" && diff.to?.kind === "checkpoint" && isCheckpoint(diff.to) &&
      diff.to.id === data?.id && diff.to.capturedAt === data.capturedAt) return diff.to;
}

function savedRoundDiff(data: CheckpointEntryData): unknown {
  const diff = data.diff as Partial<RecordedDiff> | undefined;
  if (diff?.status === "error") return diff.checkpointId === data.id ? data.diff : undefined;
  // A copied card retains its original endpoint, even if inheritance rebound the native node.
  if (savedRoundEndpoint(data)?.nodeId === data.nodeId) return data.diff;
}

type FileState = { kind: "file"; content: string; executable: boolean } |
  { kind: "symlink"; target: string; targetEncoding: "utf8" | "base64" };

interface SnapshotIdentity {
  repositoryScope?: RepositoryScope;
  sessionId: string;
  workspaceRoot: string;
}

interface FileSnapshot extends SnapshotIdentity {
  files: Record<string, FileState>;
}

interface Snapshot extends FileSnapshot {
  version: 1 | 2;
  baseline: { id: string; capturedAt: string; anchorId: string | null };
  priorEntryIds: string[];
  inheritedCheckpoints?: Checkpoint[];
}

interface Checkpoint {
  id: string;
  capturedAt: string;
  nodeId: string;
}

interface CheckpointMetadata extends SnapshotIdentity {
  checkpoint: Checkpoint;
}

type CheckpointSnapshot = CheckpointMetadata & Pick<FileSnapshot, "files">;
type InlineCheckpoint = CheckpointSnapshot & { version: 1 | 2 };

interface FileStateReference {
  digest: string;
  integrity: string;
}

interface CheckpointReference extends CheckpointMetadata {
  version: 3;
  fileState: FileStateReference;
}

type StoredCheckpoint = InlineCheckpoint | CheckpointReference;

function referencesFileState(snapshot: StoredCheckpoint): snapshot is CheckpointReference {
  return snapshot.version === 3;
}

interface SnapshotFileStamp {
  path: string;
  stat: BigIntStats;
}

export type RestoreTarget = ReturnType<SessionFiles["checkpointEndpoint"] | SessionFiles["baselineEndpoint"]>;

function isCheckpoint(value: unknown): value is Checkpoint {
  const checkpoint = value as Checkpoint | undefined;
  return !!checkpoint && typeof checkpoint.id === "string" && /^[a-zA-Z0-9_-]+$/.test(checkpoint.id) &&
    typeof checkpoint.nodeId === "string" && typeof checkpoint.capturedAt === "string";
}

function checksum(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function checkpointName(checkpoint: Checkpoint) { return `checkpoint-${checkpoint.id}.json`; }
function fileStateName(digest: string) { return `file-state-${digest}.json`; }
function checkpointPathsName(checkpoint: Checkpoint) { return `capture-paths-${checkpoint.id}.json`; }

function encodeFileState(contents: string, digest: string, instanceId: string) {
  const integrity = checksum(`${digest}:${instanceId}`);
  return { reference: { digest, integrity }, data: `{"instanceId":"${instanceId}","files":${contents},"integrity":"${integrity}"}` };
}

function decodeFileState(data: string) {
  const { instanceId, files } = JSON.parse(data);
  const contents = JSON.stringify(files);
  if (contents === undefined || typeof instanceId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instanceId)) {
    throw new Error("Invalid saved file state identity");
  }
  const encoded = encodeFileState(contents, checksum(contents), instanceId);
  if (data !== encoded.data) throw new Error("Invalid saved file state checksum");
  return { contents, files: files as unknown, reference: encoded.reference };
}

function parseSnapshot(text: string, kind: "baseline"): Snapshot;
function parseSnapshot(text: string, kind: "checkpoint"): StoredCheckpoint;
function parseSnapshot(text: string, kind: "baseline" | "checkpoint"): Snapshot | StoredCheckpoint {
  const { integrity, ...value } = JSON.parse(text);
  const reference = kind === "checkpoint" && value.version === 3;
  const hasScope = value.repositoryScope !== undefined;
  if (integrity !== checksum(JSON.stringify(value)) || (!reference && ![1, 2].includes(value.version)) ||
      (value.version === 2 || (reference && hasScope) ? !isRepositoryScope(value.repositoryScope) : hasScope) ||
      typeof value.sessionId !== "string" || typeof value.workspaceRoot !== "string" ||
      (kind === "checkpoint" ? !isCheckpoint(value.checkpoint) :
        typeof value.baseline?.id !== "string" || typeof value.baseline?.capturedAt !== "string" ||
        !(value.baseline.anchorId === null || typeof value.baseline.anchorId === "string") ||
        !Array.isArray(value.priorEntryIds) || !value.priorEntryIds.every((id: unknown) => typeof id === "string") ||
        value.inheritedCheckpoints !== undefined && (!Array.isArray(value.inheritedCheckpoints) || !value.inheritedCheckpoints.every(isCheckpoint)))) {
    throw new Error("Invalid snapshot data or integrity checksum");
  }
  if (reference) {
    if (!isDigest(value.fileState?.digest) || !isDigest(value.fileState?.integrity) || Object.hasOwn(value, "files")) {
      throw new Error("Invalid checkpoint file state reference");
    }
    return value as CheckpointReference;
  }
  value.files = validateFileStates(value.files);
  return value as Snapshot | InlineCheckpoint;
}

function validateFileStates(files: unknown): Record<string, FileState> {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Invalid snapshot file states");
  for (const [path, state] of Object.entries(files) as [string, FileState][]) {
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
      if (Object.hasOwn(files, segments.slice(0, length).join("/"))) throw new Error("Conflicting snapshot paths");
    }
  }
  return Object.assign(Object.create(null), files);
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
  private forkAttempt?: ForkAttempt;
  private inherited?: { sessionId: string; checkpoints: readonly Checkpoint[] };

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

  private async readRegularFile(path: string, stamps?: SnapshotFileStamp[]) {
    if (!(await lstat(path)).isFile()) throw new Error("Stored data is not a regular file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error("Stored data is not a regular file");
      const data = await handle.readFile();
      if (!isUtf8(data)) throw new Error("Stored data is not valid UTF-8");
      stamps?.push({ path, stat });
      return data.toString("utf8");
    } finally { await handle.close(); }
  }

  // Recheck the files actually read without opening a window between the final
  // check and association or workspace writes.
  private assertSnapshotFilesStillMatch(stamps: SnapshotFileStamp[]) {
    try {
      for (const { path, stat } of stamps) {
        if (!lstatSync(this.storageDir).isDirectory() || !lstatSync(dirname(path)).isDirectory()) {
          throw new Error("Snapshot storage is no longer an ordinary directory.");
        }
        const current = lstatSync(path, { bigint: true });
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
            current.ctimeNs !== stat.ctimeNs || current.mtimeNs !== stat.mtimeNs) {
          throw new Error("The saved snapshot changed.");
        }
        accessSync(path, constants.R_OK);
      }
    } catch (error) {
      throw new VersioningError("snapshot_unavailable", "Saved file data changed or became unavailable. " + String(error));
    }
  }

  private async publishFile(path: string, data: string) {
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      // Immutable publication never overwrites another snapshot.
      await link(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async publishSnapshot(path: string, snapshot: Snapshot | StoredCheckpoint, stamps?: SnapshotFileStamp[]) {
    const data = JSON.stringify({ ...snapshot, integrity: checksum(JSON.stringify(snapshot)) });
    await this.publishFile(path, data);
    if (stamps && await this.readRegularFile(path, stamps) !== data) throw new Error("Published snapshot changed.");
  }

  private async saveFileState(sessionId: string, files: Record<string, FileState>, stamps: SnapshotFileStamp[]): Promise<FileStateReference> {
    // Git lists tracked and untracked paths separately. The order of collection
    // is not part of the file state.
    const contents = JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]])));
    const digest = checksum(contents);
    const path = await this.storagePath(sessionId, false, fileStateName(digest));
    let stored = await this.readRegularFile(path, stamps).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stored === undefined) {
      // Bind references to this particular publication. A fresh capture of the
      // same contents must not silently resurrect checkpoints that lost their data.
      const fresh = encodeFileState(contents, digest, randomUUID());
      try { await this.publishFile(path, fresh.data); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      stored = await this.readRegularFile(path, stamps);
      if (stored === fresh.data) return fresh.reference;
    }
    try {
      const decoded = decodeFileState(stored);
      if (decoded.contents !== contents) throw new Error("Existing saved file state does not match its content address.");
      return decoded.reference;
    } catch (error) {
      throw new VersioningError("snapshot_unavailable", `Saved file state ${digest} is corrupt. ${String(error)}`);
    }
  }

  private async readFileState(sessionId: string, reference: FileStateReference, stamps?: SnapshotFileStamp[]) {
    try {
      const path = await this.storagePath(sessionId, false, fileStateName(reference.digest));
      const data = await this.readRegularFile(path, stamps);
      const decoded = decodeFileState(data);
      if (decoded.reference.digest !== reference.digest || decoded.reference.integrity !== reference.integrity) {
        throw new Error("Saved file state does not match the checkpoint's reference");
      }
      return { data, files: validateFileStates(decoded.files) };
    } catch (error) {
      throw new VersioningError("snapshot_unavailable", `Saved file state ${reference.digest} is missing, unreadable, or corrupt. ${String(error)}`);
    }
  }

  private async readUniqueFileState(snapshot: StoredCheckpoint, checked: Map<string, string>) {
    if (!referencesFileState(snapshot)) return undefined;
    const { digest, integrity } = snapshot.fileState;
    const previous = checked.get(digest);
    if (previous === integrity) return undefined;
    if (previous !== undefined) throw new VersioningError("snapshot_unavailable", "Checkpoints refer to different publications of the same file state.");
    const { data, files } = await this.readFileState(snapshot.sessionId, snapshot.fileState);
    checked.set(digest, integrity);
    return { digest, data, paths: Object.keys(files) };
  }

  // Keep just the path set independently of snapshot data, so capture can enforce
  // repository ownership even when the round comparison cannot read its predecessor.
  private async saveOwnedPaths(directory: string, paths: string[]) {
    const contents = JSON.stringify(paths.sort());
    const integrity = checksum(contents);
    const data = JSON.stringify({ paths, integrity });
    const path = join(directory, `owned-paths-${integrity}.json`);
    let existing = await this.readRegularFile(path).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing === undefined) {
      try { await this.publishFile(path, data); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      existing = await this.readRegularFile(path);
    }
    if (existing !== data) throw new Error("Invalid saved path set");
    return path;
  }

  private async knownPaths(baseline: Snapshot, previous?: Checkpoint) {
    if (!previous) return Object.keys(baseline.files);
    const path = await this.storagePath(baseline.sessionId, false, checkpointPathsName(previous));
    try {
      const { paths, integrity } = JSON.parse(await this.readRegularFile(path));
      if (!Array.isArray(paths) || !paths.every(path => typeof path === "string" && validPath(path)) ||
          checksum(JSON.stringify(paths)) !== integrity) throw new Error("Invalid saved path set");
      return paths as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new VersioningError("snapshot_unavailable", `Saved paths for checkpoint ${previous.id} are unreadable or corrupt. ${String(error)}`);
      }
    }
    const saved = await this.readCheckpointEnvelope(baseline, previous).catch(error => {
      if (!(error instanceof VersioningError) || error.code !== "snapshot_unavailable") throw error;
      return undefined;
    });
    // Keep the legacy baseline preflight when both the predecessor envelope and
    // its path record are gone. An intact reference must still supply its paths.
    return Object.keys(saved ? await this.checkpointFiles(saved) : baseline.files);
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
    const baseline = await this.readBaseline(position).catch(error => {
      if (error instanceof VersioningError && error.code === "no_baseline") return undefined;
      throw error;
    });
    if (!baseline) {
      this.forkAttempt = { kind: "no-history", sessionId: position.sessionId };
      return;
    }
    // The handoff concerns immutable history. The child validates Git separately.
    await this.savedWorkspaceDirectory(position, baseline);
    await this.assertExternalPersistence(position, baseline.workspaceRoot);
    const token = randomUUID();
    const path = await this.storagePath(position.sessionId, true, "fork-" + token + ".json");
    await writeFile(path, JSON.stringify({ sessionId: position.sessionId, entryId, position: forkPosition }), { flag: "wx", mode: 0o600 });
    this.forkAttempt = { kind: "transfer", sessionId: position.sessionId, token };
  }

  async shutdown(position: SessionPosition, event: SessionShutdownEvent) {
    if (event.reason !== "fork") {
      if (event.reason !== "reload") this.discardForkHandoff(position);
      return;
    }
    const targetSessionFile = event.targetSessionFile;
    const handoffKey = this.handoffKey(position.cwd);
    forkHandoffs.delete(handoffKey);
    const attempt = this.forkAttempt;
    this.forkAttempt = undefined;
    if (!attempt || attempt.sessionId !== position.sessionId) return;
    if (attempt.kind === "no-history") {
      forkHandoffs.set(handoffKey, { kind: "no-history", sourceFile: position.sessionFile, targetFile: targetSessionFile });
      return;
    }
    const source = await this.storagePath(position.sessionId, false, "fork-" + attempt.token + ".json");
    const intent = JSON.parse(await this.readRegularFile(source)) as ForkIntent;
    const transfer: ForkTransfer = { source: position, intent, targetSessionFile };
    if (!targetSessionFile) {
      // Capture the settled source before pi reuses the ephemeral session manager.
      await rm(source);
      forkHandoffs.set(handoffKey, { kind: "ephemeral", transfer });
      return;
    }
    const destination = this.transferPath(targetSessionFile);
    const temporary = destination + "." + attempt.token + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(transfer), { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      await rm(source);
    } finally { await rm(temporary, { force: true }); }
  }

  private handoffKey(cwd: string) {
    return JSON.stringify([this.storageDir, cwd]);
  }

  private pendingEphemeralFork(position: SessionPosition) {
    const handoff = forkHandoffs.get(this.handoffKey(position.cwd));
    return handoff?.kind === "ephemeral" && handoff.childSessionId === position.sessionId ? handoff : undefined;
  }

  private discardForkHandoff(position: SessionPosition) {
    if (this.pendingEphemeralFork(position)) forkHandoffs.delete(this.handoffKey(position.cwd));
  }

  private claimForkHandoff(position: SessionPosition, event: SessionStartEvent) {
    const key = this.handoffKey(position.cwd);
    const handoff = forkHandoffs.get(key);
    if (!handoff) return undefined;
    if (handoff.kind === "ephemeral" && handoff.childSessionId === position.sessionId && event.reason === "reload") return handoff;
    forkHandoffs.delete(key);
    if (event.reason !== "fork") return undefined;
    if (handoff.kind === "no-history") {
      return handoff.targetFile === position.sessionFile && handoff.sourceFile === event.previousSessionFile ? handoff : undefined;
    }
    if (handoff.childSessionId || position.sessionFile || event.previousSessionFile) return undefined;
    // Bind before probing Git or storage, so only this child can retry a failed start.
    handoff.childSessionId = position.sessionId;
    forkHandoffs.set(key, handoff);
    return handoff;
  }

  private transferPath(sessionFile: string) {
    return join(this.storageDir, "transfer-" + createHash("sha256").update(sessionFile).digest("hex") + ".json");
  }

  async initialize(position: SessionPosition, event: SessionStartEvent, searchDepth: (root: string) => number = () => 0) {
    this.inherited = undefined;
    const handoff = this.claimForkHandoff(position, event);
    const fork = event.reason === "fork" && handoff?.kind !== "no-history";
    const ephemeral = handoff?.kind === "ephemeral" ? handoff.transfer : undefined;
    const workspace = await findWorkspaceRoot(position.cwd).then(root => ({ root }), (error: unknown) => ({ error }));
    const root = "root" in workspace ? workspace.root : undefined;
    if (root !== undefined) await this.assertExternalPersistence(position, root);
    // File-backed receipts survive interrupted initialization and reopening.
    const receipt = event.reason !== "new" && position.sessionFile && handoff?.kind !== "no-history" ?
      await this.receiptPath(position.sessionFile) : undefined;
    const expectsInheritance = fork || receipt !== undefined || ephemeral !== undefined;
    const inheritance = expectsInheritance ? await this.completeInheritance(position, root, ephemeral, receipt) : undefined;
    if ("error" in workspace) throw workspace.error;
    if (root === undefined) {
      // A copied or previously saved baseline must not be mistaken for a non-Git session.
      if (!expectsInheritance) {
        try { await this.readBaseline(position); }
        catch (error) {
          if (error instanceof VersioningError && error.code === "no_baseline") return undefined;
          throw error;
        }
      }
      throw new VersioningError("workspace_mismatch", "The Git workspace for existing file history is unavailable.");
    }
    const restore = fork && inheritance?.restoreAfterFork === true;
    try {
      const existing = await this.load(position);
      if (existing.inheritedCheckpoints?.length) this.inherited = { sessionId: position.sessionId, checkpoints: existing.inheritedCheckpoints };
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

  private async receiptPath(sessionFile: string) {
    const path = this.transferPath(sessionFile);
    return await lstat(path).then(() => path, error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
  }

  private async completeInheritance(position: SessionPosition, root: string | undefined, ephemeral?: ForkTransfer, receipt?: string) {
    await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.storageDir)).isDirectory()) throw new Error("Snapshot storage must not traverse symbolic links");
    // Even a failed or empty native copy must never become a new baseline on reload.
    await writeFile(this.path(position.sessionId, "") + ".origin.json", JSON.stringify({ inherited: true }), { flag: "wx", mode: 0o600 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    if (await lstat(this.path(position.sessionId, "baseline.json")).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    })) return { restoreAfterFork: false };

    const transfer = ephemeral ?? (receipt ? JSON.parse(await this.readRegularFile(receipt)) as ForkTransfer : undefined);
    if (!transfer) throw new VersioningError("snapshot_unavailable", "The fork transfer is missing.");
    // The origin marker is already durable. Consume intent before publishing snapshots.
    if (receipt) await rm(receipt);
    this.discardForkHandoff(position);
    await this.inherit(position, root, transfer);
    return { restoreAfterFork: transfer.intent.position === "before" };
  }

  private async inherit(position: SessionPosition, availableRoot: string | undefined, { source, intent, targetSessionFile }: ForkTransfer) {
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
    // Copying saved snapshots needs no working files. If Git is absent, require
    // the same native cwd and retain the saved root and identities for later validation.
    const baseline = availableRoot === undefined ? await this.readBaseline(source) : await this.load(source);
    const root = baseline.workspaceRoot;
    if (availableRoot !== undefined && availableRoot !== root) {
      throw new VersioningError("workspace_mismatch", "Cannot inherit history across workspaces.");
    }
    if (availableRoot === undefined) {
      if (await this.savedWorkspaceDirectory(source, baseline) !== await canonicalLocation(position.cwd)) {
        throw new VersioningError("workspace_mismatch", "Cannot inherit history across workspaces.");
      }
      await this.assertExternalPersistence(position, root);
    }
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
    const destination = await this.storagePath(position.sessionId, true);
    const staging = await mkdtemp(join(this.storageDir, ".inherit-"));
    try {
      const inheritedCheckpoints: Checkpoint[] = [];
      const copiedFileStates = new Map<string, string>();
      const copiedOwnedPaths = new Map<string, string>();
      for (const record of this.checkpointRecords(source, baseline)) {
        const nodeId = copiedNode(record.nodeId);
        if (!nodeId) continue;
        const snapshot = await this.readCheckpointEnvelope(baseline, record);
        const shared = await this.readUniqueFileState(snapshot, copiedFileStates);
        // Publish a local copy, not a link to the source session's files.
        if (shared) {
          await this.publishFile(join(staging, fileStateName(shared.digest)), shared.data);
          copiedOwnedPaths.set(shared.digest, await this.saveOwnedPaths(staging, shared.paths));
        }
        const checkpoint = { id: record.id, capturedAt: record.capturedAt, nodeId };
        if (referencesFileState(snapshot)) await link(copiedOwnedPaths.get(snapshot.fileState.digest)!, join(staging, checkpointPathsName(checkpoint)));
        await this.publishSnapshot(join(staging, checkpointName(checkpoint)),
          { ...snapshot, checkpoint, sessionId: position.sessionId });
        inheritedCheckpoints.push(checkpoint);
      }
      const inheritedBaseline: Snapshot = { ...baseline, sessionId: position.sessionId,
        baseline: { ...baseline.baseline, anchorId }, inheritedCheckpoints };
      await this.publishSnapshot(join(staging, "baseline.json"), inheritedBaseline);
      // Publish the complete independent history at once, never a partial baseline.
      await rename(staging, dirname(destination));
    } catch (error) {
      if (error instanceof VersioningError) throw error;
      throw new VersioningError("storage_failed", String(error));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private async savedWorkspaceDirectory(position: SessionPosition, baseline: Snapshot) {
    const directory = await canonicalLocation(position.cwd);
    if (!isWithin(baseline.workspaceRoot, directory)) {
      throw new VersioningError("workspace_mismatch", "Snapshot session or workspace identity does not match.");
    }
    return directory;
  }

  private async readBaseline(position: SessionPosition, stamps?: SnapshotFileStamp[]): Promise<Snapshot> {
    let snapshot: Snapshot;
    try {
      const path = await this.storagePath(position.sessionId);
      snapshot = parseSnapshot(await this.readRegularFile(path, stamps), "baseline");
    } catch (error) {
      const inherited = await lstat(this.path(position.sessionId, "") + ".origin.json").catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      const recordedHistory = position.entries.some(entry => entry.type === "custom" &&
        (entry.customType === "tree-versioning.baseline" || entry.customType === checkpointEntryType));
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" && !recordedHistory && !inherited;
      const pending = missing && (position.sessionFile ? await this.receiptPath(position.sessionFile) : this.pendingEphemeralFork(position));
      throw new VersioningError(
        missing && !pending ? "no_baseline" : "snapshot_unavailable",
        "The session baseline is missing, unreadable, or corrupt.",
      );
    }
    if (snapshot.sessionId !== position.sessionId) {
      throw new VersioningError("workspace_mismatch", "Snapshot session identity does not match.");
    }
    return snapshot;
  }

  private async assertWorkspace(position: SessionPosition, root: string) {
    if (root !== await workspaceRoot(position.cwd)) {
      throw new VersioningError("workspace_mismatch", "Snapshot session or workspace identity does not match.");
    }
  }

  private async load(position: SessionPosition, stamps?: SnapshotFileStamp[]): Promise<Snapshot> {
    const snapshot = await this.readBaseline(position, stamps);
    await this.assertWorkspace(position, snapshot.workspaceRoot);
    return snapshot;
  }

  async record(position: SessionPosition) {
    const baseline = await this.load(position);
    await this.assertExternalPersistence(position, baseline.workspaceRoot);
    if (!position.leafId) throw new VersioningError("capture_failed", "The round has no native session node.");
    const checkpoint: Checkpoint = { id: randomUUID(), nodeId: position.leafId, capturedAt: new Date().toISOString() };
    const previous = this.nearestCheckpoint(this.checkpointRecords(position, baseline), this.branchAt(position, position.leafId));
    const knownPaths = await this.knownPaths(baseline, previous);
    const files = await capture(baseline.workspaceRoot, baseline.repositoryScope, knownPaths);
    const metadata = { sessionId: position.sessionId, workspaceRoot: baseline.workspaceRoot, repositoryScope: baseline.repositoryScope, checkpoint };
    const stamps: SnapshotFileStamp[] = [];
    try {
      const fileState = await this.saveFileState(position.sessionId, files, stamps);
      const path = await this.storagePath(position.sessionId, false, checkpointName(checkpoint));
      const ownedPaths = await this.saveOwnedPaths(dirname(path), Object.keys(files));
      await link(ownedPaths, join(dirname(path), checkpointPathsName(checkpoint)));
      await this.publishSnapshot(path, { ...metadata, version: 3, fileState }, stamps);
    } catch (error) {
      if (error instanceof VersioningError) throw error;
      throw new VersioningError("storage_failed", String(error));
    }
    const comparison = await this.compare(position, { scope: "turn" }, { ...metadata, files })
      .catch(error => unavailableRoundDiff(checkpoint.id, error));
    return { checkpoint, comparison, assertStillSaved: () => this.assertSnapshotFilesStillMatch(stamps) };
  }

  // Only an exact-node filter can skip an entry. A damaged match is an error.
  private checkpointAssociation(position: SessionPosition, entry: CustomEntry, inherited: ReadonlyMap<string, Checkpoint>,
    exactNodeId?: string) {
    const data = entry.data as CheckpointEntryData | undefined;
    const rebound = typeof data?.id === "string" ? inherited.get(data.id) : undefined;
    if (exactNodeId !== undefined && exactNodeId !== (rebound?.nodeId ?? data?.nodeId)) return undefined;
    if (isCheckpoint(data)) {
      const record = rebound ?? data;
      // Copied cards are left intact; the child can bind a removed label to the card itself.
      if (record.capturedAt === data.capturedAt && (rebound?.nodeId === entry.id ||
          entry.parentId !== null && this.branchAt(position, entry.parentId).includes(record.nodeId))) {
        return { record, data };
      }
    }
    throw new VersioningError("snapshot_unavailable", "Invalid checkpoint association.");
  }

  async roundDiffPreview(position: SessionPosition): Promise<RoundDiffPreview | undefined> {
    const { entries, leafId } = position;
    if (leafId === null) return undefined;
    const inherited = this.inherited?.sessionId === position.sessionId ? this.inherited.checkpoints : [];
    const byId = new Map(inherited.map(record => [record.id, record]));
    const detachedEndpoints: Checkpoint[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== checkpointEntryType) continue;
      let diff: unknown;
      try {
        const association = this.checkpointAssociation(position, entry, byId, leafId);
        if (!association) {
          // The saved endpoint can diagnose a broken association, never retarget the patch.
          const endpoint = savedRoundEndpoint(entry.data as CheckpointEntryData | undefined);
          if (endpoint?.nodeId === leafId && !byId.has(endpoint.id)) detachedEndpoints.push(endpoint);
          continue;
        }
        diff = savedRoundDiff(association.data);
      } catch (error) {
        if (!(error instanceof VersioningError)) throw error;
      }
      // A checkpoint rebound to its own card is already visible.
      return entry.id === leafId ? undefined : { nodeId: leafId, diff };
    }
    // A native copy ending at the checkpoint may have inherited its snapshots but not the card that followed it.
    const checkpoint = this.nearestCheckpoint(inherited, [leafId]);
    if (checkpoint) {
      const diff = await this.compare(position, { scope: "turn", checkpointId: checkpoint.id })
        .catch(error => unavailableRoundDiff(checkpoint.id, error));
      return { nodeId: leafId, diff };
    }
    if (detachedEndpoints.length) {
      // An independently saved snapshot must corroborate the detached endpoint.
      const baseline = await this.readBaseline(position).catch(() => undefined);
      if (!baseline) return undefined;
      for (const endpoint of detachedEndpoints) {
        const snapshot = await this.loadCheckpoint(baseline, endpoint)
          .catch(() => undefined);
        if (snapshot) return { nodeId: leafId, diff: undefined };
      }
    }
  }

  private checkpointRecords(position: SessionPosition, baseline: Snapshot): Checkpoint[] {
    const inherited = new Map((baseline.inheritedCheckpoints ?? []).map(record => [record.id, record]));
    const records = position.entries.filter((entry): entry is CustomEntry =>
      entry.type === "custom" && entry.customType === checkpointEntryType)
      .map(entry => this.checkpointAssociation(position, entry, inherited)!.record);
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

  private async readCheckpointEnvelope(identity: SnapshotIdentity, checkpoint: Checkpoint, stamps?: SnapshotFileStamp[]) {
    try {
      const path = await this.storagePath(identity.sessionId, false, checkpointName(checkpoint));
      const snapshot = parseSnapshot(await this.readRegularFile(path, stamps), "checkpoint");
      if (snapshot.sessionId !== identity.sessionId || snapshot.workspaceRoot !== identity.workspaceRoot ||
          snapshot.checkpoint.id !== checkpoint.id || snapshot.checkpoint.nodeId !== checkpoint.nodeId ||
          snapshot.checkpoint.capturedAt !== checkpoint.capturedAt ||
          JSON.stringify(snapshot.repositoryScope) !== JSON.stringify(identity.repositoryScope)) {
        throw new Error("Checkpoint identity or association does not match.");
      }
      return snapshot;
    } catch (error) {
      throw new VersioningError("snapshot_unavailable", `Checkpoint ${checkpoint.id} is missing, unreadable, or corrupt. ${String(error)}`);
    }
  }

  private async checkpointFiles(snapshot: StoredCheckpoint, stamps?: SnapshotFileStamp[]) {
    if (!referencesFileState(snapshot)) return snapshot.files;
    return (await this.readFileState(snapshot.sessionId, snapshot.fileState, stamps)).files;
  }

  private async loadCheckpoint(identity: SnapshotIdentity, checkpoint: Checkpoint, stamps?: SnapshotFileStamp[]): Promise<CheckpointSnapshot> {
    const snapshot = await this.readCheckpointEnvelope(identity, checkpoint, stamps);
    return { ...snapshot, files: await this.checkpointFiles(snapshot, stamps) };
  }

  private baselineEndpoint(snapshot: Snapshot) {
    return { kind: "baseline" as const, sessionId: snapshot.sessionId, workspaceRoot: snapshot.workspaceRoot, ...snapshot.baseline };
  }

  private checkpointEndpoint(snapshot: CheckpointMetadata) {
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
    const sharedStates = new Map<string, string>();
    for (const record of records) {
      const saved = await this.readCheckpointEnvelope(snapshot, record);
      await this.readUniqueFileState(saved, sharedStates);
      checkpoints.push(this.checkpointEndpoint(saved));
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

  async restore(position: SessionPosition, stillCurrent: () => boolean,
    confirm?: (target: RestoreTarget) => Promise<boolean>): Promise<RestoreTarget | undefined> {
    const stamps: SnapshotFileStamp[] = [];
    const assertReady = () => {
      if (!stillCurrent()) throw new VersioningError("restore_superseded", "The restore destination is no longer current.");
      this.assertSnapshotFilesStillMatch(stamps);
    };
    const baseline = await this.load(position, stamps);
    await this.assertExternalPersistence(position, baseline.workspaceRoot);
    const branch = this.branchAt(position, position.leafId);
    const checkpoint = this.nearestCheckpoint(this.checkpointRecords(position, baseline), branch);
    if (!checkpoint && !this.baselineCovers(baseline, branch)) {
      throw new VersioningError("no_baseline", "No saved file history covers the navigation destination.");
    }
    const saved = checkpoint && await this.loadCheckpoint(baseline, checkpoint, stamps);
    const snapshot = saved ?? baseline;
    const target = saved ? this.checkpointEndpoint(saved) : this.baselineEndpoint(baseline);
    if (confirm) {
      assertReady();
      if (await confirm(target) !== true) return;
      assertReady();
    }
    const root = snapshot.workspaceRoot;
    try {
      const scope = await workspaceScope(root, snapshot.repositoryScope);
      await scope.assertRestorable(Object.keys(snapshot.files));
      const current = await collect(root, scope);
      if (confirm) {
        // The working directory and storage location must still match after the dialog.
        await this.assertExternalPersistence(position, root);
        await this.assertWorkspace(position, root);
        scope.verifyBeforeWrite();
      }
      assertReady();
      applySnapshot(root, current, snapshot.files);
    } catch (error) {
      if (error instanceof VersioningError) throw error;
      throw new VersioningError("restore_failed", String(error));
    }
    return target;
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
      const savedSnapshot = await this.loadCheckpoint(snapshot, record);
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
