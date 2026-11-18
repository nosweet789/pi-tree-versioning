import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager, type CustomEntry, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dispose, fixture, git, load } from "./harness.ts";
import { viewFixture } from "./view-fixture.ts";
import { assertStyledCharacters, styledCharacters } from "./terminal-style.ts";
import { responseStream, useModel, type TestApp } from "./agent-fixture.ts";

initTheme("dark", false);

test("the read-only session viewer compares the baseline to the current branch without capturing disk edits", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "notes.txt"), "existing edit\n");
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  view.setTheme(app.session.extensionRunner.getUIContext().theme);
  try {
    assert.ok(app.session.extensionRunner.getCommand("tree-versioning-diff"));
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "common edit\n");
    await app.session.prompt("Common round.");
    const common = ((await app.checkpoints()).details as any).checkpoints[0];
    await writeFile(join(workspace.cwd, "abandoned.txt"), "other branch only\n");
    await app.session.prompt("Abandoned round.");
    await app.session.navigateTree(common.nodeId, { summarize: false });
    await writeFile(join(workspace.cwd, "notes.txt"), "unsnapshotted edit\n");
    const entries = app.manager.getEntries();
    const leaf = app.manager.getLeafId();
    const baseline = ((await app.checkpoints()).details as any).baseline;
    const gitState = git(workspace.cwd, "status", "--porcelain");
    let opened = false;
    view.inspect(component => {
      opened = true;
      const summary = component.render(120).map(stripVTControlCharacters).join("\n");
      assert.match(summary, /Saved session diff/);
      assert.ok(summary.includes(baseline.id));
      assert.ok(summary.includes(common.id));
      assert.match(summary, /notes.txt.*\+1.*-1/);
      assert.doesNotMatch(summary, /abandoned.txt|unsnapshotted edit/);
      component.handleInput?.("\x0f");
      const expanded = component.render(120).map(line => stripVTControlCharacters(line).trimEnd()).join("\n");
      assert.match(expanded, /-existing edit\n\+common edit/);
      assert.doesNotMatch(expanded, /committed|unsnapshotted edit|other branch only/);
    });
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(opened, true);
    view.verify();
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.equal(app.manager.getLeafId(), leaf);
    assert.equal(git(workspace.cwd, "status", "--porcelain"), gitState);
    assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "unsnapshotted edit\n");
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});


test("the same historical card changes language in place and after reload or reopening without changing saved history", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  let reopened: TestApp | undefined;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "中文-code.ts"), "const greeting = '原始 English';\n");
    await app.session.prompt("Record a bilingual path.");
    const entry = cards(app)[0];
    const comparison = (await app.diff({ scope: "turn" })).details;
    const entries = app.manager.getEntries();
    const renderer = app.session.extensionRunner.getEntryRenderer(entry.customType)!;
    const mounted = new CustomEntryComponent(entry, renderer);
    assert.match(mounted.render(120).map(stripVTControlCharacters).join("\n"), /Round diff/);
    await app.command("zh-CN");
    assert.match(mounted.render(120).map(stripVTControlCharacters).join("\n"), /轮次差异/);
    assert.match(app.session.extensionRunner.getCommand("tree-versioning-diff")!.description!, /会话总差异/);
    await app.session.prompt("/tree-versioning-diff help");
    assert.match(app.notices.at(-1)!.message, /用法.*会话基线/);
    assert.match(rendered(app, entry, true), /const greeting = '原始 English';/);
    assert.match(rendered(app, entry), /中文-code.ts/);
    assert.deepEqual((await app.diff({ scope: "turn" })).details, comparison);
    assert.deepEqual(app.manager.getEntries(), entries);
    await app.session.reload();
    assert.match(rendered(app, cards(app)[0]), /轮次差异/);
    assert.deepEqual(app.manager.getEntries(), entries);
    assert.deepEqual((await app.diff({ scope: "turn" })).details, comparison);
    const sessionFile = app.manager.getSessionFile()!;
    dispose(app.session);
    reopened = await load(workspace, SessionManager.open(sessionFile));
    assert.match(rendered(reopened, cards(reopened)[0]), /轮次差异/);
    assert.deepEqual(reopened.manager.getEntries(), entries);
    assert.deepEqual((await reopened.diff({ scope: "turn" })).details, comparison);
    await reopened.command("en");
    assert.match(rendered(reopened, cards(reopened)[0]), /Round diff/);
    assert.deepEqual(reopened.manager.getEntries(), entries);
  } finally { dispose(app.session, ...(reopened ? [reopened.session] : [])); }
});

test("an unchanged round and a baseline-only session explicitly display an empty saved comparison", async () => {
  const workspace = await fixture();
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  view.setTheme(app.session.extensionRunner.getUIContext().theme);
  try {
    let opened = false;
    view.inspect(component => {
      opened = true;
      assert.match(component.render(100).map(stripVTControlCharacters).join("\n"), /No file changes/);
    });
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(opened, true);
    view.verify();
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("An unchanged round.");
    assert.equal(cards(app).length, 1);
    assert.match(rendered(app, cards(app)[0]), /No file changes/);
    await app.command("zh-CN");
    assert.match(rendered(app, cards(app)[0]), /没有文件变化/);
  } finally { dispose(app.session); }
});

test("missing predecessor history produces a durable error card rather than an empty diff or a false capture failure", async () => {
  const workspace = await fixture();
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  view.setTheme(app.session.extensionRunner.getUIContext().theme);
  try {
    const storage = join(workspace.agentDir, "tree-versioning", app.manager.getSessionId());
    const originalFiles = new Set(await readdir(storage));
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("First round.");
    const first = ((await app.checkpoints()).details as any).checkpoints[0];
    const newFiles = (await readdir(storage)).filter(name => !originalFiles.has(name));
    for (const name of newFiles) await rm(join(storage, name));
    let opened = false;
    view.inspect(() => { opened = true; });
    const entriesBeforeQuery = app.manager.getEntries();
    for (const [locale, expected] of [["en", /missing, unreadable, or corrupt/], ["zh-CN", /缺失、不可读或已损坏/]] as const) {
      await app.command(locale);
      await app.session.prompt("/tree-versioning-diff");
      assert.match(app.notices.at(-1)!.message, expected);
      assert.equal(app.notices.at(-1)!.type, "error");
      assert.equal(opened, false);
      assert.deepEqual(app.manager.getEntries(), entriesBeforeQuery);
    }
    await app.command("en");
    await writeFile(join(workspace.cwd, "notes.txt"), "second saved state\n");
    await app.session.prompt("Record despite missing predecessor.");
    assert.equal(cards(app).length, 2);
    const failed = cards(app)[1];
    assert.match(rendered(app, failed), /checkpoint was recorded.*diff is unavailable/);
    assert.match(rendered(app, failed), /missing, unreadable, or corrupt/);
    assert.doesNotMatch(rendered(app, failed), /No file changes|round was not recorded/);
    assert.doesNotMatch(app.notices.at(-1)!.message, /round was not recorded/);
    assert.equal(((await app.diff({ scope: "session" })).details as any).status, "ok");
    assert.notEqual(((await app.diff({ scope: "session" })).details as any).to.id, first.id);
    const entries = app.manager.getEntries();
    await app.command("zh-CN");
    assert.match(rendered(app, failed), /检查点已记录.*差异不可用/);
    await app.session.reload();
    assert.match(rendered(app, cards(app)[1]), /检查点已记录.*差异不可用/);
    assert.deepEqual(app.manager.getEntries(), entries);
  } finally { dispose(app.session); }
});

test("unreadable semantic card data renders a localized error instead of disappearing or claiming no changes", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await app.session.prompt("Create a card.");
    const customType = cards(app)[0].customType;
    for (const data of [undefined, { status: "ok", files: [], to: null }, { status: "error", code: "unknown", checkpointId: "unavailable" }]) {
      const damaged: CustomEntry = { ...cards(app)[0], customType,
        data: { ...(cards(app)[0].data as object), diff: data } };
      assert.match(rendered(app, damaged), /Saved diff display data is unavailable/);
      await app.command("zh-CN");
      assert.match(rendered(app, damaged), /已保存的差异展示数据不可用/);
      assert.doesNotMatch(rendered(app, damaged), /没有文件变化/);
      await app.command("en");
    }
  } finally { dispose(app.session); }
});

test("terminal controls in paths and patches are displayed inertly while the stored comparison stays verbatim", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    const path = "odd\x1b[2J\nname.txt";
    const content = "source\x1b]52;c;payload\x07\rtext\n";
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, path), content);
    await app.session.prompt("Record control characters.");
    const entry = cards(app)[0];
    const raw = cardComponent(app, entry, true).render(120).join("\n");
    assert.ok(!raw.includes("\x1b[2J"));
    assert.ok(!raw.includes("\x1b]52"));
    assert.ok(!raw.includes("\x07") && !raw.includes("\r"));
    assert.match(stripVTControlCharacters(raw), /odd\\u001b\[2J\\u000aname.txt/);
    assert.match(stripVTControlCharacters(raw), /source\\u001b\]52;c;payload\\u0007\\u000dtext/);
    const comparison = (await app.diff({ scope: "turn" })).details as any;
    assert.equal(comparison.files[0].path, path);
    assert.ok(comparison.files[0].patch.includes(content));
    assert.deepEqual((entry.data as { diff: unknown }).diff, comparison);
  } finally { dispose(app.session); }
});

test("escaped controls next to combining marks do not produce over-wide patch rows", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  const combining = (control: string) => ["abc" + control + "\ufe0f\u20e3tail", "abcdefg" + control + "\u093Etail",
    "abcdefg" + control + "\uFF9Etail"].join("\ncontext\n") + "\n";
  await writeFile(path, combining("\x08"));
  const app = await load(workspace);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, combining("\x07"));
    await app.session.prompt("Replace a literal control character before a combining mark.");
    const lines = cardComponent(app, cards(app)[0], true).render(14);
    assert.ok(lines.every(line => visibleWidth(line) <= 14), "Escaped controls and their neighbors must fit");
    const visible = lines.map(line => stripVTControlCharacters(line).trimEnd()).join("");
    assert.ok(visible.includes("+abc\\u0007\ufe0f\u20e3tail"));
    for (const extension of ["\u093E", "\uFF9E"]) {
      assert.ok(lines.some(line => stripVTControlCharacters(line).includes("7" + extension)),
        "The printable escape and grapheme extension must not split across rows");
    }
    assert.ok(!lines.some(line => line.includes("\x07")));
  } finally { dispose(app.session); }
});

test("a patch glyph wider than the viewport is shown as a readable escape, not an over-wide row", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, "甲\ncontext\nfoo\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, "乙\ncontext\n\u093Efoo\n");
    await writeFile(join(workspace.cwd, "added.txt"), "丙\n\t\u093E\n\u093Ebar\n");
    await app.session.prompt("Replace a wide glyph and add a file containing another.");
    const component = cardComponent(app, cards(app)[0], true);
    const narrow = component.render(1);
    assert.ok(narrow.every(line => visibleWidth(line) <= 1));
    const plain = narrow.map(line => stripVTControlCharacters(line).trimEnd()).join("");
    assert.ok(plain.includes("-\\u{7532}+\\u{4e59}"));
    assert.ok(plain.includes("+\\u{4e19}"), "Line-only additions must handle the same width limit");
    assert.ok(plain.includes("\\u{20}\\u{93e}"), "Expanded tab columns must be measured with their neighboring glyph");
    assert.ok(plain.includes("+\\u{93e}foo") && plain.includes("+\\u{93e}bar"), "Keep the addition prefix literal even before a wide leading mark");
    const wide = component.render(120);
    assertPatchRow(wide, theme, "toolDiffAdded", "+", ["乙"]);
    assertPatchRow(wide, theme, "toolDiffAdded", "+", ["\u093E"], "foo");
  } finally { dispose(app.session); }
});

test("Chinese text, long paths, resizing, and paged expansion retain the full diff within terminal columns", async () => {
  const workspace = await fixture();
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  view.setTheme(app.session.extensionRunner.getUIContext().theme);
  try {
    await app.command("zh-CN");
    const path = "中文-long-path-".repeat(6) + "code.ts";
    const content = Array.from({ length: 2100 }, (_, index) => `const line${index} = '中文 English 👩‍💻 é';`).join("\n") + "\nEND-OF-DIFF-中文\n";
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, path), content);
    await app.session.prompt("Record a long diff.");
    const entry = cards(app)[0];
    const component = cardComponent(app, entry, true);
    const originalData = JSON.stringify(entry.data);
    for (const width of [120, 24, 12, 40]) {
      const lines = component.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `Every line must fit ${width} columns`);
      const flattened = lines.map(stripVTControlCharacters).join("").replace(/\s/g, "");
      assert.ok(flattened.includes(path));
      assert.ok(flattened.includes("constline2099='中文English👩‍💻é';"));
      assert.ok(flattened.includes("END-OF-DIFF-中文"));
    }
    const darkLines = component.render(120);
    initTheme("light", false);
    component.invalidate();
    const lightLines = component.render(120);
    assert.notDeepEqual(lightLines, darkLines);
    assert.deepEqual(lightLines.map(stripVTControlCharacters), darkLines.map(stripVTControlCharacters));
    initTheme("dark", false);
    view.keybindings.setUserBindings({ "app.tools.expand": "ctrl+e", "tui.select.pageDown": "ctrl+n" });
    let opened = false;
    view.inspect(screen => {
      opened = true;
      assert.match(screen.render(120).map(stripVTControlCharacters).join("\n"), /ctrl\+e.*展开/);
      screen.handleInput?.("\x05");
      view.terminal.columns = 24;
      view.terminal.rows = 12;
      screen.invalidate();
      let reachedEnd = false;
      for (let page = 0; page < 1500; page++) {
        const lines = screen.render(24);
        assert.ok(lines.length <= 12);
        assert.ok(lines.every(line => visibleWidth(line) <= 24));
        if (lines.some(line => stripVTControlCharacters(line).includes("END-OF-DIFF-中文"))) { reachedEnd = true; break; }
        screen.handleInput?.("\x0e");
      }
      assert.equal(reachedEnd, true, "The last patch line must be reachable without truncation");
    });
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(opened, true);
    view.verify();
    assert.equal(JSON.stringify(entry.data), originalData);
  } finally { initTheme("dark", false); dispose(app.session); }
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`${mode} reports that the viewer requires a terminal without starting a model or changing history`, async () => {
    const workspace = await fixture();
    const app = await load(workspace, undefined, { mode });
    try {
      await app.command("zh-CN");
      const entries = app.manager.getEntries();
      await app.session.prompt("/tree-versioning-diff");
      const message = mode === "rpc" ? app.notices.at(-1)!.message : app.errors.at(-1)!;
      assert.match(message, /需要交互式终端模式/);
      assert.match(message, /session_diff/);
      assert.deepEqual(app.manager.getEntries(), entries);
    } finally { dispose(app.session); }
  });
}

for (const navigate of [false, true]) {
  test(`diff publication ${navigate ? "overlapping navigation" : "without navigation"} keeps cards on their recorded branch`, async () => {
    const workspace = await fixture();
    const app = await load(workspace);
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await app.session.prompt("Common round.");
      const common = ((await app.checkpoints()).details as any).checkpoints[0];
      let navigation: ReturnType<typeof app.session.navigateTree> | undefined;
      const unsubscribe = app.session.subscribe(event => {
        if (navigate && event.type === "entry_appended" && event.entry.type === "custom" &&
            event.entry.customType === "tree-versioning.checkpoint") {
          navigation = app.session.navigateTree(common.nodeId, { summarize: false });
        }
      });
      await writeFile(join(workspace.cwd, "notes.txt"), "later branch only\n");
      await app.session.prompt("Later round.");
      await navigation;
      unsubscribe();
      assert.equal(cards(app).length, 2);
      if (navigate) {
        assert.ok(navigation);
        assert.equal(app.manager.getLeafId(), common.nodeId, "Automatic display must not append to the navigation destination");
        const activeCards = app.manager.getBranch().filter(entry => entry.type === "custom" &&
          app.session.extensionRunner.getEntryRenderer(entry.customType));
        assert.doesNotMatch(JSON.stringify(activeCards), /later branch only/);
      } else {
        assert.match(rendered(app, cards(app)[1], true), /later branch only/);
      }
    } finally { dispose(app.session); }
  });
}

function cards(app: TestApp) {
  return app.manager.getEntries().filter((entry): entry is CustomEntry =>
    entry.type === "custom" && !!app.session.extensionRunner.getEntryRenderer(entry.customType));
}

function cardComponent(app: TestApp, entry: CustomEntry, expanded = false) {
  const renderer = app.session.extensionRunner.getEntryRenderer(entry.customType)!;
  const component = renderer(entry, {
    expanded,
    keyText: () => "ctrl+o",
    keyHint: (_key, description) => `ctrl+o ${description}`,
  }, app.session.extensionRunner.getUIContext().theme);
  assert.ok(component, "A persisted diff card must have visible content");
  return component;
}

function rendered(app: TestApp, entry: CustomEntry, expanded = false, width = 120) {
  return cardComponent(app, entry, expanded).render(width).map(line => stripVTControlCharacters(line).trimEnd()).join("\n");
}

function assertPatchRow(lines: string[], theme: Theme, color: ThemeColor, ...spans: (string | [string])[]) {
  const text = spans.flat().join("");
  const row = lines.find(line => stripVTControlCharacters(line).trimEnd() === text.trimEnd());
  assert.ok(row, `Missing patch line: ${text}`);
  assertStyledCharacters(styledCharacters(row).slice(0, Array.from(text).length), theme, color, ...spans);
}

test("an expanded round diff emphasizes the entire replaced value without emphasizing its prefix", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, "timeout = 30\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, "timeout = 60\n");
    await app.session.prompt("Change the timeout.");
    const entry = cards(app)[0];
    const lines = cardComponent(app, entry, true).render(120);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-timeout = ", ["30"]);
    assertPatchRow(lines, theme, "toolDiffAdded", "+timeout = ", ["60"]);
    assert.doesNotMatch(rendered(app, entry), /timeout = /, "The folded summary must not show the patch");
  } finally { dispose(app.session); }
});

test("an expanded round diff shows separate changes and leaves one-sided insertions and deletions on their own side", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, "ratio=0.25, fruit=apple, flag=on, port=300\ncontext\nname=makeBlueCar\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, "ratio=0.75, fruit=apples, flag=off, port=1300\ncontext\nname=makeCar\n");
    await app.session.prompt("Insert and replace several fragments, and delete another.");
    const lines = cardComponent(app, cards(app)[0], true).render(120);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-ratio=", ["0.25"], ", fruit=apple, flag=o", ["n"], ", port=300");
    assertPatchRow(lines, theme, "toolDiffAdded", "+ratio=", ["0.75"], ", fruit=apple", ["s"], ", flag=o", ["ff"], ", port=", ["1"], "300");
    assertPatchRow(lines, theme, "toolDiffRemoved", "-name=make", ["Blue"], "Car");
    assertPatchRow(lines, theme, "toolDiffAdded", "+name=makeCar");
  } finally { dispose(app.session); }
});

test("inserting a space that splits a word does not turn unchanged text into a deletion", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, "foo bar\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, "f oo bar\n");
    await app.session.prompt("Split a word with a single space.");
    const lines = cardComponent(app, cards(app)[0], true).render(120);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-foo bar");
    assertPatchRow(lines, theme, "toolDiffAdded", "+f", [" "], "oo bar");
  } finally { dispose(app.session); }
});

test("inline fragments stay in their own fields and distinguish whole numbers from identifier digits", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, "x=1111,y=2,n=-30,field123=-2.5e-3\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, "x=2,y=1111,n=-60,field153=-4.5e-3\n");
    await app.session.prompt("Replace values in several fields and change an identifier digit.");
    const lines = cardComponent(app, cards(app)[0], true).render(120);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-x=", ["1111"], ",y=", ["2"], ",n=", ["-30"], ",field1", ["2"], "3=", ["-2.5e-3"]);
    assertPatchRow(lines, theme, "toolDiffAdded", "+x=", ["2"], ",y=", ["1111"], ",n=", ["-60"], ",field1", ["5"], "3=", ["-4.5e-3"]);
  } finally { dispose(app.session); }
});

test("field boundaries keep swapped text in place without aligning repeated spaces across edits", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  await writeFile(path, 'a="p q r s",b="X"\ncontext\nfoo bar\ncontext\nlet n=-1.e3,mask=0x30;\n');
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, 'a="X",b="p q r s"\ncontext\nf oo baz\ncontext\nlet n=-2.e3,mask=0x60;\n');
    await app.session.prompt("Swap field values, insert a space alongside a replacement, and change numeric literals.");
    const lines = cardComponent(app, cards(app)[0], true).render(120);
    assertPatchRow(lines, theme, "toolDiffRemoved", '-a="', ["p q r s"], '",b="', ["X"], '"');
    assertPatchRow(lines, theme, "toolDiffAdded", '+a="', ["X"], '",b="', ["p q r s"], '"');
    assertPatchRow(lines, theme, "toolDiffRemoved", "-foo ba", ["r"]);
    assertPatchRow(lines, theme, "toolDiffAdded", "+f", [" "], "oo ba", ["z"]);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-let n=", ["-1.e3"], ",mask=", ["0x30"], ";");
    assertPatchRow(lines, theme, "toolDiffAdded", "+let n=", ["-2.e3"], ",mask=", ["0x60"], ";");
  } finally { dispose(app.session); }
});

test("positions alone pair a single deletion and addition, without pairing other change runs", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  const betweenHunks = Array.from({ length: 12 }, (_, index) => `context ${index}`);
  await writeFile(path, ["only-old", "separator", "first = old", "second = old", "keep", ...betweenHunks, "aaa"].join("\n"));
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, ["separator", "first = new", "second = new", "keep", "only-new", ...betweenHunks, "ZZZ"].join("\n"));
    await app.session.prompt("Record unpaired runs and a full-line replacement without final newlines.");
    const entry = cards(app)[0];
    const rawBefore = (await app.diff({ scope: "turn" })).details;
    const lines = cardComponent(app, entry, true).render(120);
    for (const row of ["-only-old", "-first = old", "-second = old"]) assertPatchRow(lines, theme, "toolDiffRemoved", row);
    for (const row of ["+only-new", "+first = new", "+second = new"]) assertPatchRow(lines, theme, "toolDiffAdded", row);
    assertPatchRow(lines, theme, "toolDiffRemoved", "-", ["aaa"]);
    assertPatchRow(lines, theme, "toolDiffAdded", "+", ["ZZZ"]);
    assert.equal(lines.filter(line => stripVTControlCharacters(line).trimEnd() === "\\ No newline at end of file").length, 2);
    assert.deepEqual((await app.diff({ scope: "turn" })).details, rawBefore);
    assert.deepEqual((entry.data as { diff: unknown }).diff, rawBefore);
  } finally { dispose(app.session); }
});

test("one expansion shares its inline work budget across files and still displays the whole patch", async () => {
  const workspace = await fixture();
  const earlyPath = join(workspace.cwd, "notes.txt");
  const largePath = join(workspace.cwd, "z-large.txt");
  const lastPath = join(workspace.cwd, "zz-last.txt");
  const large = (character: string) => Array.from({ length: 20 }, (_, index) =>
    character.repeat(4096) + index + "\nseparator " + index + "\n").join("");
  await writeFile(earlyPath, "early timeout = 30\n");
  await writeFile(largePath, large("a"));
  await writeFile(lastPath, "late timeout = 30\n");
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(earlyPath, "early timeout = 60\n");
    await writeFile(largePath, large("Z"));
    await writeFile(lastPath, "late timeout = 60\n");
    await app.session.prompt("Record small replacements on both sides of a large patch.");
    const component = cardComponent(app, cards(app)[0], true);
    const wide = component.render(120);
    assertPatchRow(wide, theme, "toolDiffAdded", "+early timeout = ", ["60"]);
    assertPatchRow(wide, theme, "toolDiffRemoved", "-late timeout = 30");
    assertPatchRow(wide, theme, "toolDiffAdded", "+late timeout = 60");
    const text = wide.map(line => stripVTControlCharacters(line).trimEnd()).join("");
    assert.ok(text.includes("+" + "Z".repeat(4096) + "19"), "Falling back must retain all of the patch text");
    component.invalidate();
    component.render(24);
    assert.deepEqual(component.render(120), wide, "Resizing and redrawing must not restart highlighting work");
  } finally { dispose(app.session); }
});

test("hunk-like text in a multiline filename stays file metadata", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  const theme = app.session.extensionRunner.getUIContext().theme;
  try {
    const fakeHeader = "@@ -9,1 +9,1 @@";
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, `odd\n${fakeHeader}\n-fake old\n+fake new`), "actual addition\n");
    await app.session.prompt("Record a path containing hunk-like text.");
    const lines = cardComponent(app, cards(app)[0], true).render(120);
    for (const text of [fakeHeader, "-fake old", "+fake new"]) {
      const occurrences = lines.filter(line => stripVTControlCharacters(line).trimEnd() === text);
      assert.equal(occurrences.length, 2, "Both file headers must retain their text");
      for (const line of occurrences) {
        assertStyledCharacters(styledCharacters(line).slice(0, text.length), theme, "muted", text);
      }
    }
    assertPatchRow(lines, theme, "toolDiffAdded", "+actual addition");
  } finally { dispose(app.session); }
});

test("expanded diffs distinguish changes, context, and metadata without mistaking patch content for headers", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "notes.txt"), "context\n-- removed\nlast\n");
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  const theme = app.session.extensionRunner.getUIContext().theme;
  view.setTheme(theme);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "context\n++ added\nlast\n");
    await app.session.prompt("Record patch lines resembling headers.");
    const checkPatch = (lines: string[]) => {
      const output = lines.join("\n");
      const removed = lines.find(line => stripVTControlCharacters(line).trimEnd() === "--- removed");
      const added = lines.find(line => stripVTControlCharacters(line).trimEnd() === "+++ added");
      assert.ok(removed && added, "Both changed lines must be visible");
      for (const [line, color] of [[removed, "toolDiffRemoved"], [added, "toolDiffAdded"]] as const) {
        const foreground = styledCharacters(theme.fg(color, "x"))[0].foreground;
        const text = stripVTControlCharacters(line).trimEnd();
        assert.ok(styledCharacters(line).slice(0, text.length).every(character => character.foreground === foreground),
          "Content resembling a file header must keep its change color");
      }
      assertPatchRow(lines, theme, "toolDiffContext", " context");
      assertPatchRow(lines, theme, "muted", "--- a/notes.txt");
      assertPatchRow(lines, theme, "accent", "@@ -1,3 +1,3 @@");
      assert.ok(output.includes(theme.fg("warning", "Modified")));
      assert.match(stripVTControlCharacters(output), / context\s*\n--- removed\s*\n\+\+\+ added\s*\n last/);
    };
    checkPatch(cardComponent(app, cards(app)[0], true).render(120));
    view.inspect(component => {
      view.sendKey("\x0f");
      checkPatch(component.render(120));
    });
    await app.session.prompt("/tree-versioning-diff");
    view.verify();
  } finally { dispose(app.session); }
});

test("cards and the session viewer emphasize paths and statistics using the active theme", async () => {
  const workspace = await fixture();
  const view = viewFixture();
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  const theme = app.session.extensionRunner.getUIContext().theme;
  view.setTheme(theme);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "saved text\n");
    await app.session.prompt("Record a styled diff.");
    const checkSummary = (lines: string[], title: string) => {
      const output = lines.join("\n");
      assert.ok(output.includes(theme.bold(title)), "The title must be bold");
      assert.ok(output.includes(theme.bold("notes.txt")), "Paths must stand out from metadata");
      assert.ok(output.includes(theme.fg("toolDiffAdded", "+1")));
      assert.ok(output.includes(theme.fg("toolDiffRemoved", "-1")));
      assert.ok(lines.some(line => /^─{3,}\s*$/.test(stripVTControlCharacters(line))), "Separate the diff from ordinary text");
      assert.ok(lines.some(line => line.includes(theme.fg("muted", stripVTControlCharacters(line).trimEnd())) &&
        /From:|起点：/.test(stripVTControlCharacters(line))), "Endpoints must have secondary emphasis");
      assert.doesNotMatch(stripVTControlCharacters(output), /saved text|@@/);
    };
    for (const palette of ["dark", "light"]) {
      initTheme(palette, false);
      for (const locale of ["en", "zh-CN"]) {
        await app.command(locale);
        checkSummary(cardComponent(app, cards(app)[0]).render(120), locale === "en" ? "Round diff" : "轮次差异");
        view.inspect(component => checkSummary(component.render(120), locale === "en" ? "Saved session diff" : "已保存的会话总差异"));
        await app.session.prompt("/tree-versioning-diff");
        view.verify();
      }
    }
  } finally { initTheme("dark", false); dispose(app.session); }
});

test("a recorded round displays persistent endpoints, file statistics, binary summaries, and expandable text", async () => {
  const workspace = await fixture();
  await writeFile(join(workspace.cwd, "removed.txt"), "remove me\n");
  const app = await load(workspace);
  try {
    await app.command("en");
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "saved text\n");
    await writeFile(join(workspace.cwd, "new.txt"), "new text\n");
    await writeFile(join(workspace.cwd, "image.bin"), Buffer.from([0, 1, 2]));
    await rm(join(workspace.cwd, "removed.txt"));
    await app.session.prompt("Record these changes.");
    assert.equal(cards(app).length, 1);
    const entry = cards(app)[0];
    const catalog = (await app.checkpoints()).details as any;
    const summary = rendered(app, entry);
    assert.match(summary, /Round diff/);
    assert.ok(summary.includes(catalog.baseline.id));
    assert.ok(summary.includes(catalog.checkpoints[0].id));
    assert.match(summary, /notes.txt.*\+1.*-1/);
    assert.match(summary, /new.txt.*\+1.*-0/);
    assert.match(summary, /removed.txt.*\+0.*-1/);
    assert.match(summary, /image.bin.*Binary.*Added/);
    assert.doesNotMatch(summary, /saved text|@@/);
    assert.match(summary, /ctrl\+o/);
    const expanded = rendered(app, entry, true);
    assert.match(expanded, /-committed\n\+saved text/);
    assert.match(expanded, /\+new text/);
    assert.match(expanded, /-remove me/);
    assert.doesNotMatch(expanded, /--- a\/image.bin|\+\+\+ b\/image.bin/);
    assert.deepEqual(app.errors, []);
  } finally { dispose(app.session); }
});
