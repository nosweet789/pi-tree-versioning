import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { en } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";

export type LanguagePreference = "en" | "zh-CN" | "auto";
export type MessageKey = keyof typeof en;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "en" || value === "zh-CN" || value === "auto";
}

function systemLanguage(): "en" | "zh-CN" {
  const locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale).split(/[.@]/)[0].replaceAll("_", "-");
  if (/^zh(?:-Hans(?:-[A-Z]+)?|-CN|-SG)?$/i.test(locale)) return "zh-CN";
  return "en";
}

export class Language {
  preference: LanguagePreference = "auto";

  constructor(private readonly path: string) {}

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (!isLanguagePreference(value.language)) throw new Error("Invalid language preference");
      this.preference = value.language;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async save(preference: LanguagePreference) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ language: preference }) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      this.preference = preference;
    } finally { await rm(temporary, { force: true }); }
  }

  message(key: MessageKey, parameters: Record<string, string | number> = {}): string {
    const locale = this.preference === "auto" ? systemLanguage() : this.preference;
    const resources = locale === "zh-CN" ? zhCN : en;
    return resources[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
      if (!(name in parameters)) throw new Error(`Missing message parameter: ${key}.${name}`);
      return String(parameters[name]);
    });
  }
}
