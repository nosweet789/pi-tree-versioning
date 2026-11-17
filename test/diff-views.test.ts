import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dispose, fixture, git, load } from "./harness.ts";
import { viewFixture } from "./view-fixture.ts";
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
      assert.ok(output.includes(theme.fg("toolDiffRemoved", "--- removed")), "Removed content is not a file header");
      assert.ok(output.includes(theme.fg("toolDiffAdded", "+++ added")), "Added content is not a file header");
      assert.ok(output.includes(theme.fg("toolDiffContext", " context")));
      assert.ok(output.includes(theme.fg("muted", "--- a/notes.txt")));
      assert.ok(output.includes(theme.fg("accent", "@@ -1,3 +1,3 @@")));
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
