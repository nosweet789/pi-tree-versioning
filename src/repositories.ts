import { isUtf8 } from "node:buffer";
import { execFile, spawnSync } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalLocation, isWithin } from "./paths.ts";

const exec = promisify(execFile);
const searchEntryLimit = 10_000;
const repositoryLimit = 256;
const searchTimeout = 30_000;

export interface RepositoryIdentity {
  path: string;
  gitDirectory: string;
  commonDirectory: string;
  device: number;
  inode: number;
}

export interface RepositoryScope {
  searchDepth: number;
  repositories: RepositoryIdentity[];
}

export function isSearchDepth(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validPath(path: string): boolean {
  return !path.includes("\0") && !isAbsolute(path) &&
    !(sep === "\\" && (path.includes("\\") || /^[a-z]:/i.test(path))) &&
    !path.split("/").some(segment => ["", ".", "..", ".git"].includes(segment.toLowerCase()));
}


function gitOptions(locale?: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  if (locale) environment.LC_ALL = locale;
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete environment[key];
  }
  return { env: environment, encoding: "buffer" as const, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 };
}

function decodeGitOutput(stdout: Buffer, stderr: Buffer) {
  // Git may exit successfully while warning that unreadable directories were skipped.
  if (stderr.length) throw new Error("Git reported a diagnostic: " + String(stderr));
  if (!isUtf8(stdout)) throw new Error("Git returned paths that are not valid UTF-8");
  return stdout.toString("utf8");
}

async function git(cwd: string, args: string[], { input, locale }: { input?: string; locale?: string } = {}): Promise<string> {
  const command = exec("git", ["-C", cwd, ...args], gitOptions(locale));
  const inputComplete = input === undefined ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const stream = command.child.stdin!;
    stream.on("error", reject);
    stream.end(input, (error?: Error | null) => error ? reject(error) : resolve());
  });
  const [{ stdout, stderr }] = await Promise.all([command.catch(error => {
    if (args[0] === "check-ignore" && error.code === 1) return { stdout: Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0) };
    throw error;
  }), inputComplete]);
  return decodeGitOutput(stdout, stderr);
}

export async function workspaceRoot(cwd: string): Promise<string> {
  const output = await git(cwd, ["rev-parse", "--show-toplevel"], { locale: "C" });
  return realpath(output.replace(/\r?\n$/, ""));
}

async function discoveryCeilings() {
  const ceilings = new Set<string>();
  let resolveSymlinks = true;
  for (const entry of (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter)) {
    // Git trusts entries after the first empty component to be free of symlinks.
    if (!entry) { resolveSymlinks = false; continue; }
    if (!isAbsolute(entry)) continue;
    const ceiling = resolveSymlinks ? await realpath(entry).catch(() => undefined) :
      entry.replace(sep === "\\" ? /[\\/]+$/ : /\/+$/, "");
    if (ceiling) ceilings.add(ceiling);
  }
  return ceilings;
}

/** Initialization may skip an absent worktree, but validation of saved worktrees stays strict. */
export async function findWorkspaceRoot(cwd: string): Promise<string | undefined> {
  try { return await workspaceRoot(cwd); }
  catch (error) {
    const failure = error as { code?: number; stderr?: Buffer };
    if (failure?.code !== 128 || !Buffer.isBuffer(failure.stderr)) throw error;
    const diagnostic = failure.stderr.toString("utf8").trimEnd();
    // Git discovered a repository, but it has no working tree here (e.g. a bare repository).
    if (diagnostic === "fatal: this operation must be run in a work tree") return undefined;
    const mount = /^fatal: not a git repository \(or any parent up to mount point (.+)\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/s.exec(diagnostic);
    if (!mount && diagnostic !== "fatal: not a git repository (or any of the parent directories): .git") throw error;

    const currentDirectory = await realpath(cwd);
    const boundary = mount ? await realpath(mount[1]!) : undefined;
    if (boundary && !isWithin(boundary, currentDirectory)) throw error;
    const ceilings = await discoveryCeilings();
    // Git can report the same diagnostic for an invalid or unreadable .git directory.
    // Git searches the current directory and mount root, but not its discovery ceiling.
    for (let directory = currentDirectory; ; directory = dirname(directory)) {
      if (directory !== currentDirectory && ceilings.has(directory)) return undefined;
      const marker = await lstat(join(directory, ".git")).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (marker) throw error;
      if (directory === boundary || dirname(directory) === directory) return undefined;
    }
  }
}


async function entryLocation(path: string) {
  const stat = await lstat(path).catch(error => {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    return undefined;
  });
  // Resolve filesystem spelling without following a leaf symbolic link.
  const location = stat && !stat.isSymbolicLink() ? await realpath(path) :
    join(await canonicalLocation(dirname(path)), basename(path));
  return { location, stat };
}


async function statIfPresent(path: string) {
  return lstat(path).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });
}

async function isAdministrativeDirectory(path: string) {
  if (!(await statIfPresent(join(path, "HEAD")))?.isFile() ||
      !(await statIfPresent(join(path, "objects")))?.isDirectory() ||
      !(await statIfPresent(join(path, "refs")))?.isDirectory()) return false;
  return await realpath((await git(path, ["rev-parse", "--absolute-git-dir"])).replace(/\r?\n$/, "")) === path;
}

async function isRepositoryBoundary(path: string) {
  return !!await statIfPresent(join(path, ".git")) || await isAdministrativeDirectory(path);
}

async function assertDirectory(root: string, path: string) {
  let current = root;
  for (const segment of [".", ...path.split("/").filter(segment => segment !== ".")]) {
    current = join(current, segment);
    if (!(await lstat(current)).isDirectory()) throw new Error("Repository path is missing or traverses a symbolic link: " + current);
  }
}

function matchesDirectory(stat: Stats, expected: Pick<Stats, "dev" | "ino">) {
  return stat.isDirectory() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function verifyGitDirectory(identity: RepositoryIdentity, stat: Stats) {
  if (!matchesDirectory(stat, { dev: identity.device, ino: identity.inode })) {
    throw new Error("Repository disappeared or changed during collection: " + identity.path);
  }
}

type AdministrativePathFlag = "--absolute-git-dir" | "--git-common-dir";
const administrativePathArgs = (flag: AdministrativePathFlag) => ["rev-parse", "--path-format=absolute", flag];

function liveAdministrativePath(directory: string, flag: AdministrativePathFlag) {
  // Resolve redirects using Git's own rules. Keep this last read bounded because
  // it runs synchronously in the write window rather than during collection.
  const { error, status, stdout, stderr } = spawnSync("git", ["-C", directory, ...administrativePathArgs(flag)], {
    ...gitOptions(), timeout: 5_000, killSignal: "SIGKILL",
  });
  if (error) throw error;
  if (status !== 0) throw new Error("Git could not resolve the repository layout before restoration: " + directory);
  return realpathSync.native(decodeGitOutput(stdout, stderr).replace(/\r?\n$/, ""));
}

async function repository(root: string, path: string) {
  await assertDirectory(root, path);
  const directory = join(root, path);
  const markerPath = join(directory, ".git");
  const marker = await lstat(markerPath);
  if (path !== "." && !marker.isDirectory()) throw new Error("Nested repository is no longer an ordinary repository: " + path);
  if (await workspaceRoot(directory) !== directory) throw new Error("Repository root changed: " + path);
  const administrativePath = async (flag: AdministrativePathFlag) =>
    realpath((await git(directory, administrativePathArgs(flag))).replace(/\r?\n$/, ""));
  const gitDirectory = await administrativePath("--absolute-git-dir");
  const commonMarkerPath = join(gitDirectory, "commondir");
  const commonMarker = await statIfPresent(commonMarkerPath);
  const commonDirectory = await administrativePath("--git-common-dir");
  const layoutBindings = [
    { path: markerPath, stat: marker, flag: "--absolute-git-dir", resolved: gitDirectory },
    { path: commonMarkerPath, stat: commonMarker, flag: "--git-common-dir", resolved: commonDirectory },
  ] as const;
  if (path !== "." && (gitDirectory !== join(directory, ".git") || commonDirectory !== gitDirectory)) {
    throw new Error("Nested worktrees and redirected Git directories are not supported: " + path);
  }
  const administrative = await lstat(gitDirectory);
  const commonIdentity = commonDirectory === gitDirectory ? undefined : await lstat(commonDirectory);
  const identity: RepositoryIdentity = {
    path, gitDirectory, commonDirectory, device: administrative.dev, inode: administrative.ino,
  };
  const tracked = await git(directory, ["ls-files", "--stage", "-z"]);
  const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = new Set(untracked.split("\0").filter(Boolean));
  const trackedPaths = new Set<string>();
  const excluded = [gitDirectory, commonDirectory];
  for (const record of tracked.split("\0").filter(Boolean)) {
    const file = record.slice(record.indexOf("\t") + 1);
    if (record.startsWith("160000 ")) excluded.push(join(directory, file));
    else { paths.add(file); trackedPaths.add(file); }
  }
  return { identity, directory, paths, trackedPaths, excluded, layoutBindings, commonIdentity };
}

/** Discover only at baseline creation. Later reads validate the saved coverage instead. */
export async function discoverRepositories(root: string, searchDepth: number): Promise<RepositoryScope> {
  if (!isSearchDepth(searchDepth)) throw new Error("Invalid repository search depth");
  const deadline = Date.now() + searchTimeout;
  const checkDeadline = () => {
    if (Date.now() > deadline) throw new Error("Repository search exceeded its time limit");
  };
  const first = await repository(root, ".");
  const repositories = [first.identity];
  const excluded = new Set(first.excluded);
  const pending = [{ path: ".", depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const parent = pending.pop()!;
    if (parent.depth >= searchDepth) continue;
    await assertDirectory(root, parent.path);
    for await (const entry of await opendir(join(root, parent.path))) {
      checkDeadline();
      if (++entries > searchEntryLimit) throw new Error("Repository search exceeded its entry limit");
      if (!entry.isDirectory() || entry.name.toLowerCase() === ".git") continue;
      const path = parent.path === "." ? entry.name : parent.path + "/" + entry.name;
      if (!validPath(path)) continue;
      const directory = join(root, path);
      if ([...excluded].some(exclusion => isWithin(exclusion, directory))) continue;
      await assertDirectory(root, path);
      if (await isAdministrativeDirectory(directory)) continue;
      const marker = await statIfPresent(join(directory, ".git"));
      if (marker && !marker.isDirectory()) continue;
      if (marker) {
        if (repositories.length >= repositoryLimit) throw new Error("Repository search exceeded its repository limit");
        const nested = await repository(root, path);
        repositories.push(nested.identity);
        for (const exclusion of nested.excluded) excluded.add(exclusion);
      }
      pending.push({ path, depth: parent.depth + 1 });
    }
  }
  checkDeadline();
  const nested = repositories.slice(1).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { searchDepth, repositories: [first.identity, ...nested] };
}

export function isRepositoryScope(value: unknown): value is RepositoryScope {
  const scope = value as RepositoryScope | undefined;
  if (!scope || !isSearchDepth(scope.searchDepth) || !Array.isArray(scope.repositories) ||
      !scope.repositories.length || scope.repositories.length > repositoryLimit || scope.repositories[0]?.path !== ".") return false;
  const paths = new Set<string>();
  for (const item of scope.repositories) {
    if (!item || typeof item.path !== "string" ||
        !(item.path === "." || validPath(item.path) && item.path.split("/").length <= scope.searchDepth) ||
        paths.has(item.path) || !isAbsolute(item.gitDirectory ?? "") || !isAbsolute(item.commonDirectory ?? "") ||
        !Number.isSafeInteger(item.device) || !Number.isSafeInteger(item.inode)) return false;
    paths.add(item.path);
  }
  return true;
}

export function repositoryCoverage(scope?: RepositoryScope) {
  return { searchDepth: scope?.searchDepth ?? 0, repositories: scope?.repositories.map(item => item.path) ?? ["."] };
}

/** One scope owns candidate enumeration, repository ownership, and restore preflight. */
export async function workspaceScope(root: string, saved?: RepositoryScope) {
  const repositories: Awaited<ReturnType<typeof repository>>[] = [];
  for (const expected of saved?.repositories ?? [{ path: "." }]) {
    const current = await repository(root, expected.path);
    if (saved && JSON.stringify(current.identity) !== JSON.stringify(expected)) {
      throw new Error("Repository identity or administrative layout changed: " + expected.path);
    }
    repositories.push(current);
  }
  const exclusions = await Promise.all(repositories.flatMap(item => item.excluded).map(async path => ({
    path, ...await entryLocation(path),
  })));
  const marker = await lstat(join(root, ".git"));
  const alternate = await statIfPresent(join(root, ".GIT"));
  const caseInsensitive = alternate?.dev === marker.dev && alternate.ino === marker.ino;
  const spelling = (path: string) => caseInsensitive ? path.normalize("NFD").toLowerCase() : path;
  const contains = (parent: string, child: string) => isWithin(spelling(parent), spelling(child));
  for (const item of repositories.slice(1)) {
    if (exclusions.some(exclusion => contains(exclusion.location, item.directory))) {
      throw new Error("Enrolled repository is now inside excluded content: " + item.identity.path);
    }
  }
  const byPath = new Map(repositories.map(item => [item.identity.path, item]));
  const specificity = (item: typeof repositories[number]) => item.identity.path === "." ? 0 : item.identity.path.length;
  const declaredOwner = (path: string) => repositories.filter(item =>
    item.identity.path === "." || path.startsWith(item.identity.path + "/"))
    .sort((left, right) => specificity(right) - specificity(left))[0]!;
  const ownership = new Map<string, Promise<string | undefined>>();
  const currentOwner = (path: string): Promise<string | undefined> => {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const cached = ownership.get(parent);
    if (cached) return cached;
    const checking = (async () => {
      let owner = ".";
      let current = "";
      for (const segment of parent === "." ? [] : parent.split("/")) {
        current = current ? current + "/" + segment : segment;
        const stat = await statIfPresent(join(root, current));
        if (!stat) break;
        if (!stat.isDirectory()) return stat.isFile() ? owner : undefined;
        if (byPath.has(current)) owner = current;
        else if (await isRepositoryBoundary(join(root, current))) return current;
      }
      return owner;
    })();
    ownership.set(parent, checking);
    return checking;
  };
  const paths = new Set<string>();
  const trackedPaths = new Set<string>();
  for (const item of repositories) {
    for (const local of item.paths) {
      const path = item.identity.path === "." ? local : item.identity.path + "/" + local;
      if (!validPath(path) || declaredOwner(path) !== item || await currentOwner(path) !== item.identity.path) continue;
      paths.add(path);
      if (item.trackedPaths.has(local)) trackedPaths.add(path);
    }
  }
  const excludes = async (path: string, replacingDirectory = false) => {
    if (await currentOwner(path) !== declaredOwner(path).identity.path) return true;
    const entry = await entryLocation(join(root, path));
    if (replacingDirectory && entry.stat?.isDirectory() && await isAdministrativeDirectory(entry.location)) return true;
    return !contains(root, entry.location) || exclusions.some(exclusion =>
      contains(exclusion.location, entry.location) ||
      replacingDirectory && contains(entry.location, exclusion.location) ||
      entry.stat && exclusion.stat && entry.stat.dev === exclusion.stat.dev && entry.stat.ino === exclusion.stat.ino);
  };
  return {
    paths, excludes,
    async assertOwnership(knownPaths: string[]) {
      for (const path of knownPaths) {
        // Missing ordinary directories are file deletions; a new repository boundary is not.
        const owner = await currentOwner(path);
        const leafIsRepository = owner !== undefined && (await statIfPresent(join(root, path)))?.isDirectory() &&
          await isRepositoryBoundary(join(root, path));
        // Do not resolve descendants through a replaced symbolic-link ancestor.
        // Lexical gitlink protection still applies even when that ancestor is a link.
        const absolute = join(root, path);
        const location = owner === undefined ? absolute : (await entryLocation(absolute)).location;
        const excluded = exclusions.some(exclusion => contains(exclusion.path, absolute) || contains(exclusion.location, location));
        if (owner !== undefined && owner !== declaredOwner(path).identity.path || leafIsRepository || excluded) {
          throw new Error("A new repository boundary intersects saved files: " + path);
        }
      }
    },
    async assertRestorable(targetPaths: string[]) {
      for (const path of targetPaths) {
        if (await excludes(path, true)) throw new Error("Restore would replace excluded content: " + path);
      }
      for (const item of repositories) {
        const targets = targetPaths.filter(path => declaredOwner(path) === item && !trackedPaths.has(path))
          .map(path => item.identity.path === "." ? path : path.slice(item.identity.path.length + 1));
        if (targets.length && await git(item.directory, ["check-ignore", "--no-index", "-z", "--stdin"], { input: targets.join("\0") + "\0" })) {
          throw new Error("Restore would replace an untracked ignored path in repository: " + item.identity.path);
        }
      }
    },
    async verify() {
      for (const { identity } of repositories) {
        await assertDirectory(root, identity.path);
        verifyGitDirectory(identity, await lstat(identity.gitDirectory));
      }
    },
    verifyBeforeWrite() {
      // Join the synchronous restore window after the caller's final Git lookup.
      for (const { directory, identity, layoutBindings, commonIdentity } of repositories) {
        if (realpathSync.native(directory) !== directory) throw new Error("Repository path changed before restoration: " + identity.path);
        for (const { path, stat, flag, resolved } of layoutBindings) {
          const current = lstatSync(path, { throwIfNoEntry: false });
          if (stat?.dev !== current?.dev || stat?.ino !== current?.ino ||
              (stat && !stat.isDirectory() && (stat.ctimeMs !== current?.ctimeMs || stat.size !== current?.size ||
                liveAdministrativePath(directory, flag) !== resolved))) {
            throw new Error("Repository layout changed before restoration: " + identity.path);
          }
        }
        verifyGitDirectory(identity, lstatSync(identity.gitDirectory));
        if (commonIdentity && !matchesDirectory(lstatSync(identity.commonDirectory), commonIdentity)) {
          throw new Error("Common Git directory changed before restoration: " + identity.path);
        }
      }
    },
  };
}
