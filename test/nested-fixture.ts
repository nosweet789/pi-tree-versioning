import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispose, git, load, type Fixture } from "./harness.ts";

export async function nestedRepository(workspace: Fixture, path = "nested") {
  const directory = join(workspace.cwd, path);
  await mkdir(directory, { recursive: true });
  git(directory, "init", "-q");
  await writeFile(join(directory, "notes.txt"), "nested before\n");
  git(directory, "add", ".");
  git(directory, "-c", "user.name=Integration Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial nested state");
  return directory;
}

export async function setDepth(workspace: Fixture, depth: number) {
  const app = await load(workspace);
  try { await app.session.prompt("/tree-versioning-repository-depth " + depth); }
  finally { dispose(app.session); }
}

export async function gitIdentity(directory: string) {
  return {
    head: git(directory, "rev-parse", "HEAD"), branch: git(directory, "symbolic-ref", "HEAD"),
    index: await readFile(join(directory, ".git", "index")),
    config: await readFile(join(directory, ".git", "config")),
  };
}
