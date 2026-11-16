import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isLanguagePreference, type LanguagePreference } from "./language.ts";

interface PreferenceValues {
  language: LanguagePreference;
  restoreEnabled: boolean;
}

function parsePreferences(content: string): PreferenceValues {
  const value = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension preferences");
  const language = value.language === undefined ? "auto" : value.language;
  const restoreEnabled = value.restoreEnabled === undefined ? true : value.restoreEnabled;
  if (!isLanguagePreference(language)) throw new Error("Invalid language preference");
  if (typeof restoreEnabled !== "boolean") throw new Error("Invalid file restoration preference");
  return { language, restoreEnabled };
}

export class Preferences {
  private values: PreferenceValues = { language: "auto", restoreEnabled: true };
  private readonly pendingSaves = new Set<Promise<void>>();

  constructor(private readonly path: string) {}

  get language() { return this.values.language; }
  get restoreEnabled() { return this.values.restoreEnabled; }

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
    const saving = withFileMutationQueue(this.path, async () => {
      let previous = this.values;
      try {
        previous = parsePreferences(await readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      readCompleted = true;
      const values = { ...previous, ...update };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(values) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
        // Other runtimes' preferences are preserved on disk, not hot-applied here.
        this.values = { ...this.values, ...update };
      } finally { await rm(temporary, { force: true }); }
    });
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
