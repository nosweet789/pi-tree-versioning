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
  constructor(private readonly preference: () => LanguagePreference) {}

  message(key: MessageKey, parameters: Record<string, string | number> = {}): string {
    const preference = this.preference();
    const locale = preference === "auto" ? systemLanguage() : preference;
    const resources = locale === "zh-CN" ? zhCN : en;
    return resources[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
      if (!(name in parameters)) throw new Error(`Missing message parameter: ${key}.${name}`);
      return String(parameters[name]);
    });
  }
}
