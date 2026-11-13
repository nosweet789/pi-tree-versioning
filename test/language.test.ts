import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { en } from "../src/locales/en.ts";
import { zhCN } from "../src/locales/zh-CN.ts";

test("the existing terminal completion provider updates command help immediately after a language change", async () => {
  const testWorkspace = await fixture();
  const cached = new CombinedAutocompleteProvider([{
    name: "tree-versioning-language", description: "[extension] Choose the tree-versioning language",
  }], testWorkspace.cwd);
  const app = await load(testWorkspace, undefined, { autocomplete: cached });
  try {
    const existing = app.autocomplete!;
    const input = "/tree-versioning-l";
    const suggestions = () => existing.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
    assert.match((await suggestions())!.items[0].description!, /Choose/);
    await app.command("zh-CN");
    assert.equal(app.autocomplete, existing);
    assert.match((await suggestions())!.items[0].description!, /^\[extension\] .*语言/);
    assert.equal((await suggestions())!.items[0].value, "tree-versioning-language");
    await app.command("en");
    assert.match((await suggestions())!.items[0].description!, /Choose/);
  } finally { dispose(app.session); }
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} reports unreadable preferences without blocking baseline initialization`, async () => {
    const testWorkspace = await fixture();
    const storage = join(testWorkspace.agentDir, "tree-versioning");
    await mkdir(storage);
    await writeFile(join(storage, "preferences.json"), "{invalid");
    const app = await load(testWorkspace, undefined, { mode, expectedStartupErrors: 1 });
    try {
      assert.match(app.errors[0], /language preference/);
      const catalog = await app.checkpoints();
      assert.equal(catalog.isError, false, JSON.stringify(catalog));
      assert.equal((catalog.details as any).baseline.kind, "baseline");
      assert.deepEqual(((await app.diff({ scope: "session" })).details as any).files, []);
      assert.deepEqual(app.notices, []);
    } finally { dispose(app.session); }
  });
}

test("auto recognizes supported system locales and falls back to English for unsupported locales", async () => {
  const previous = process.env.LC_ALL;
  try {
    for (const [locale, expected] of [
      ["zh_CN.UTF-8", /语言/], ["zh-Hans-SG", /语言/], ["en_GB.UTF-8", /language/],
      ["fr_FR.UTF-8", /language/], ["C", /language/], ["zh_TW.UTF-8", /language/],
    ] as const) {
      process.env.LC_ALL = locale;
      const app = await load(await fixture());
      try {
        await app.command("help");
        assert.match(app.notices.at(-1)!.message, expected, locale);
        await app.command("en");
        assert.match(app.notices.at(-1)!.message, /Language/);
        await app.command("auto");
        await app.command("help");
        assert.match(app.notices.at(-1)!.message, expected, locale);
      } finally { dispose(app.session); }
    }
  } finally { process.env.LC_ALL = previous; }
});

test("English and Simplified Chinese resources have identical keys and placeholder parameters", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(zhCN[key]), placeholders(en[key]), key);
    assert.ok(en[key].length > 0 && zhCN[key].length > 0, key);
  }
});

test("language selection overrides the system and persists across reload and new sessions without changing pi settings", async () => {
  const testWorkspace = await fixture();
  const settingsPath = join(testWorkspace.agentDir, "settings.json");
  await writeFile(settingsPath, '{"theme":"dark"}\n');
  const app = await load(testWorkspace);
  try {
    assert.ok(app.session.extensionRunner.getCommand("tree-versioning-language"));
    await app.command("zh-CN");
    assert.match(app.notices.at(-1)!.message, /语言.*zh-CN/);
    assert.match(app.session.extensionRunner.getCommand("tree-versioning-language")!.description!, /语言/);
    await app.command("help");
    assert.match(app.notices.at(-1)!.message, /语言/);
    const chinese = await app.diff({ files: ["../outside"] });
    assert.equal(chinese.isError, true);
    assert.match(chinese.content[0].type === "text" ? chinese.content[0].text : "", /路径/);
    const beforeQuery = await readFile(join(testWorkspace.agentDir, "tree-versioning", "preferences.json"), "utf8");
    await app.diff();
    assert.equal(await readFile(join(testWorkspace.agentDir, "tree-versioning", "preferences.json"), "utf8"), beforeQuery);
    await app.session.reload();
    await app.command("help");
    assert.match(app.notices.at(-1)!.message, /语言/);
    await app.command("en");
    const english = await app.diff({ files: ["../outside"] });
    assert.deepEqual(english.details, chinese.details);
    assert.match(english.content[0].type === "text" ? english.content[0].text : "", /paths/i);
    await app.command("zh-CN");
    assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"dark"}\n');
  } finally { dispose(app.session); }
  const next = await load(testWorkspace);
  try {
    await next.command("help");
    assert.match(next.notices.at(-1)!.message, /语言/);
    assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"dark"}\n');
  } finally { dispose(next.session); }
});
