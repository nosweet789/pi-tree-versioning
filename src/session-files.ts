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
  branchIds: string[];
  entryIds: string[];
  hasConversation: boolean;
  hasBaselineRecord: boolean;
}

type FileState = { kind: "file"; content: string; executable: boolean } |
  { kind: "symlink"; target: string; targetEncoding: "utf8" | "base64" };

interface Snapshot {
  version: 1;
  sessionId: string;
  workspaceRoot: string;
  baseline: { id: string; capturedAt: string; anchorId: string | null };
  files: Record<string, FileState>;
  priorEntryIds: string[];
}

function validPath(path: string): boolean {
  return !path.includes("\0") && !isAbsolute(path) &&
    !(sep === "\\" && (path.includes("\\") || /^[a-z]:/i.test(path))) &&
    !path.split("/").some(segment => ["", ".", "..", ".git"].includes(segment.toLowerCase()));
}

function checksum(snapshot: Snapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function parseSnapshot(text: string): Snapshot {
  const { integrity, ...value } = JSON.parse(text);
  if (integrity !== checksum(value as Snapshot) || value.version !== 1 ||
      typeof value.sessionId !== "string" || typeof value.workspaceRoot !== "string" ||
      typeof value.baseline?.id !== "string" || typeof value.baseline?.capturedAt !== "string" ||
      !(value.baseline.anchorId === null || typeof value.baseline.anchorId === "string") ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files) ||
      !Array.isArray(value.priorEntryIds) || !value.priorEntryIds.every((id: unknown) => typeof id === "string")) {
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
  return value as Snapshot;
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

  private path(sessionId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session identity");
    return join(this.storageDir, sessionId, "baseline.json");
  }

  private async storagePath(sessionId: string, create = false): Promise<string> {
    const path = this.path(sessionId);
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

  async initialize(position: SessionPosition) {
    const root = await workspaceRoot(position.cwd);
    const canonicalStorage = await canonicalLocation(this.storageDir);
    if (isWithin(root, canonicalStorage) || position.sessionFile && isWithin(root, await canonicalLocation(position.sessionFile))) {
      throw new VersioningError("storage_failed", "Snapshot storage and session persistence must be outside the managed workspace.");
    }
    try {
      const existing = await this.load(position);
      return { baseline: existing.baseline, created: !position.hasBaselineRecord, workspaceRoot: root };
    } catch (error) {
      if (!(error instanceof VersioningError) || error.code !== "no_baseline") throw error;
    }
    const snapshot: Snapshot = {
      version: 1, sessionId: position.sessionId, workspaceRoot: root,
      baseline: {
        id: randomUUID(), capturedAt: new Date().toISOString(),
        anchorId: position.hasConversation ? position.leafId : null,
      },
      files: await capture(root),
      priorEntryIds: position.hasConversation ? position.entryIds : [],
    };
    try {
      const path = await this.storagePath(position.sessionId, true);
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify({ ...snapshot, integrity: checksum(snapshot) }), { mode: 0o600, flag: "wx" });
        // Publish without replacing a baseline another instance may have just saved.
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return { baseline: (await this.load(position)).baseline, created: !position.hasBaselineRecord, workspaceRoot: root };
      } finally { await rm(temporary, { force: true }); }
      return { baseline: snapshot.baseline, created: true, workspaceRoot: root };
    } catch (error) {
      throw new VersioningError("storage_failed", String(error));
    }
  }

  private async load(position: SessionPosition): Promise<Snapshot> {
    let snapshot: Snapshot;
    try {
      const path = await this.storagePath(position.sessionId);
      if (!(await lstat(path)).isFile()) throw new Error("Snapshot is not a regular file");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Snapshot is not a regular file");
        snapshot = parseSnapshot(await handle.readFile("utf8"));
      } finally { await handle.close(); }
    } catch (error) {
      throw new VersioningError(
        (error as NodeJS.ErrnoException).code === "ENOENT" && !position.hasBaselineRecord ? "no_baseline" : "snapshot_unavailable",
        "The session baseline is missing, unreadable, or corrupt.",
      );
    }
    if (snapshot.sessionId !== position.sessionId || snapshot.workspaceRoot !== await workspaceRoot(position.cwd)) {
      throw new VersioningError("workspace_mismatch", "Snapshot session or workspace identity does not match.");
    }
    return snapshot;
  }

  async diff(position: SessionPosition, requestedFiles?: string[]) {
    const selected = requestedFiles === undefined ? undefined : new Set(requestedFiles.map(path => {
      const relative = path.startsWith("@") ? path.slice(1) : path;
      if (!validPath(relative)) {
        throw new VersioningError("invalid_request", "File filters must be safe repository-relative paths.");
      }
      return relative;
    }));
    const snapshot = await this.load(position);
    const anchor = snapshot.baseline.anchorId;
    const anchorIndex = anchor === null ? -1 : position.branchIds.indexOf(anchor);
    const priorEntries = new Set(snapshot.priorEntryIds);
    if (anchor !== null && anchorIndex === -1 ||
        position.branchIds.slice(anchorIndex + 1).some(id => priorEntries.has(id))) {
      throw new VersioningError("no_baseline", "No baseline covers the current session position.");
    }
    const current = await capture(snapshot.workspaceRoot);
    const files = [];
    for (const path of [...new Set([...Object.keys(snapshot.files), ...Object.keys(current)])].sort()) {
      if (selected && !selected.has(path)) continue;
      const before = snapshot.files[path];
      const after = current[path];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      files.push(compare(path, before, after));
    }
    return {
      status: "ok" as const, scope: "workspace" as const,
      from: { kind: "baseline" as const, sessionId: snapshot.sessionId, workspaceRoot: snapshot.workspaceRoot, ...snapshot.baseline },
      to: { kind: "workspace" as const, workspaceRoot: snapshot.workspaceRoot },
      files,
    };
  }
}
