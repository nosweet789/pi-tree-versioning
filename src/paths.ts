import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export async function canonicalLocation(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalLocation(parent), basename(path));
  }
}

export function isWithin(root: string, path: string): boolean {
  const location = relative(root, path);
  return location !== ".." && !location.startsWith(".." + sep) && !isAbsolute(location);
}
