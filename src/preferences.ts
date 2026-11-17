import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isSearchDepth } from "./repositories.ts";
import { isLanguagePreference, type LanguagePreference } from "./language.ts";

interface PreferenceValues {
  language: LanguagePreference;
  restoreEnabled: boolean;
  repositoryDepths: Record<string, number>;
}

function parsePreferences(content: string): PreferenceValues {
  const value = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension preferences");
  const language = value.language === undefined ? "auto" : value.language;
  const restoreEnabled = value.restoreEnabled === undefined ? true : value.restoreEnabled;
  if (!isLanguagePreference(language)) throw new Error("Invalid language preference");
  if (typeof restoreEnabled !== "boolean") throw new Error("Invalid file restoration preference");
  const repositoryDepths = value.repositoryDepths === undefined ? {} : value.repositoryDepths;
  if (!repositoryDepths || typeof repositoryDepths !== "object" || Array.isArray(repositoryDepths) ||
      Object.entries(repositoryDepths).some(([root, depth]) => !isAbsolute(root) || !isSearchDepth(depth))) {
    throw new Error("Invalid repository search preferences");
  }
  return { language, restoreEnabled, repositoryDepths };
}

async function withPreferenceLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Preference lock is busy or stale: " + lock);
      await delay(25);
    }
  }
  // Never steal a lock from another process. A crash leaves a recoverable, fail-closed lock.
  try { return await action(); }
  finally { await rm(lock, { recursive: true }); }
}

export class Preferences {
  private values: PreferenceValues = { language: "auto", restoreEnabled: true, repositoryDepths: {} };
  private readonly pendingSaves = new Set<Promise<void>>();

  constructor(private readonly path: string) {}

  get language() { return this.values.language; }
  get restoreEnabled() { return this.values.restoreEnabled; }
  repositoryDepth(root: string) { return this.values.repositoryDepths[root] ?? 0; }

  async saveRepositoryDepth(root: string, depth: number) {
    if (!isAbsolute(root) || !isSearchDepth(depth)) throw new Error("Invalid repository search preference");
    await this.save({ repositoryDepths: { [root]: depth } });
  }

  async load() {
    try {
      this.values = parsePreferences(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // An unreadable switch must not silently enable destructive restoration.
      this.values = { ...this.values, restoreEnabled: false };
      throw error;
    }
  }

  async save(update: Partial<PreferenceValues>) {
    let readCompleted = false;
    const saving = withFileMutationQueue(this.path, () => withPreferenceLock(this.path, async () => {
      let previous = this.values;
      try {
        previous = parsePreferences(await readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      readCompleted = true;
      const values = { ...previous, ...update, repositoryDepths: { ...previous.repositoryDepths, ...update.repositoryDepths } };
      const temporary = this.path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(values) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
        // Other runtimes' preferences are preserved on disk, not hot-applied here.
        this.values = { ...this.values, ...update, repositoryDepths: { ...this.values.repositoryDepths, ...update.repositoryDepths } };
      } finally { await rm(temporary, { force: true }); }
    }));
    this.pendingSaves.add(saving);
    try { await saving; }
    catch (error) {
      // Queue registration can fail while resolving the preference path, before the read callback.
      if (!readCompleted) this.values = { ...this.values, restoreEnabled: false };
      throw error;
    } finally { this.pendingSaves.delete(saving); }
  }

  async waitForSaves() {
    while (this.pendingSaves.size) await Promise.allSettled(this.pendingSaves);
  }
}
