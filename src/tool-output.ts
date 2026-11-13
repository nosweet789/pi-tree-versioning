import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin } from "./paths.ts";

export async function exportOutput(text: string, workspaceRoot: string | undefined, filename: string): Promise<string> {
  if (!workspaceRoot) throw new Error("No validated workspace is available for safe output export");
  const temporaryRoot = await realpath(tmpdir());
  if (isWithin(workspaceRoot, temporaryRoot)) throw new Error("Temporary output directory must be outside the workspace");
  const directory = await mkdtemp(join(temporaryRoot, "pi-tree-versioning-output-"));
  const path = join(directory, filename);
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
  return path;
}
