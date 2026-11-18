import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { viewFixture } from "./view-fixture.ts";
import { assertStyledCharacters, styledCharacters } from "./terminal-style.ts";

initTheme("dark", false);

for (const mode of ["regular", "fullscreen"] as const) for (const changed of [false, true]) {
  test(`${mode} opens ${changed ? "short" : "empty"} diffs in the input region without an overlay and stays within half a screen`, async () => {
    const workspace = await fixture();
    const view = viewFixture(mode);
    view.terminal.columns = 80;
    view.terminal.rows = 24;
    const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
    view.setTheme(app.session.extensionRunner.getUIContext().theme);
    try {
      if (changed) {
        await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
        await writeFile(join(workspace.cwd, "notes.txt"), "short change\n");
        await app.session.prompt("Record a short diff.");
      }
      view.inspect(component => {
        assert.equal(view.hasOverlay(), false, "The viewer must replace input, not float above it");
        const screen = view.screenLines().map(stripVTControlCharacters);
        assert.ok(screen.findIndex(line => line.includes("Saved session diff")) >= 12, screen.join("\n"));
        assert.ok(screen.some(line => line.includes(changed ? "notes.txt" : "No file changes")));
        assert.match(screen.at(-1)!, /Footer/);
        assert.ok(component.render(80).length <= 12);
        assert.doesNotMatch(screen.join("\n"), /Unsubmitted draft/);
      });
      await app.session.prompt("/tree-versioning-diff");
      view.verify();
      assert.deepEqual(app.errors, []);
    } finally { dispose(app.session); }
  });
}

test("a wrapped patch preserves one-sided spaces and expanded tabs at the column break", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  const prefix = "甲".repeat(6) + "x";
  const other = "乙".repeat(6) + "y";
  await writeFile(path, `${prefix}尾\ncontext\n${other}\t末\n`);
  const view = viewFixture("fullscreen");
  view.terminal.columns = 14;
  view.terminal.rows = 160;
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  const theme = app.session.extensionRunner.getUIContext().theme;
  view.setTheme(theme);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, `${prefix} 尾\ncontext\n${other}末\n`);
    await app.session.prompt("Insert a space and delete an expanded tab at the wrapping boundary.");
    view.inspect(() => {
      view.sendKey("\x0f");
      const screen = view.screenLines();
      assert.ok(screen.every(line => visibleWidth(line) <= 14));
      for (const [sign, head, space, tail, color] of [
        ["+", prefix, " ", "尾", "toolDiffAdded"], ["-", other, "   ", "末", "toolDiffRemoved"],
      ] as const) {
        const start = screen.findIndex(line => stripVTControlCharacters(line) === sign + head);
        assert.ok(start >= 0, `Missing wrapped change: ${sign}${head}`);
        const continuation = styledCharacters(screen[start + 1]);
        const last = continuation.findIndex(({ text }) => text === tail);
        assertStyledCharacters(continuation.slice(0, last + 1), theme, color, [space], tail);
      }
    });
    await app.session.prompt("/tree-versioning-diff");
    view.verify();
  } finally { dispose(app.session); }
});

test("highlighted Unicode whitespace survives wrapping without reflowing words when it fits", async () => {
  const workspace = await fixture();
  const path = join(workspace.cwd, "notes.txt");
  const prefix = "甲".repeat(6);
  await writeFile(path, `${prefix}尾\ncontext\nabcdefgh abcdefgh abcdefgh\ncontext\nabcdefghijkl\u00a0 \n`);
  const view = viewFixture();
  view.terminal.columns = 14;
  view.terminal.rows = 160;
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  const theme = app.session.extensionRunner.getUIContext().theme;
  view.setTheme(theme);
  try {
    await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
    await writeFile(path, `${prefix}\u00a0尾\ncontext\nabcdefgh abcdefgh abcdefgh \ncontext\nabcdefghijkl \u00a0 \n`);
    await app.session.prompt("Insert a nonbreaking space and add trailing whitespace to a long line.");
    view.inspect(() => {
      view.sendKey("\x0f");
      const screen = view.screenLines();
      assert.ok(screen.every(line => visibleWidth(line) <= 14));
      const characters = screen.flatMap(styledCharacters);
      const space = characters.find(character => character.text === "\u00a0");
      assert.ok(space?.bold && space.underline, "The Unicode whitespace itself must be emphasized");
      const start = screen.findIndex(line => stripVTControlCharacters(line).trimEnd() === "+abcdefgh");
      assert.ok(start >= 0, "The first word should stay whole");
      assert.equal(stripVTControlCharacters(screen[start + 1]).trimEnd(), "abcdefgh");
      assertStyledCharacters(styledCharacters(screen[start + 2]).slice(0, 9), theme, "toolDiffAdded", "abcdefgh", [" "]);

      const repeatedSpace = screen.find(line => stripVTControlCharacters(line).startsWith("+abcdefghijkl"));
      assert.ok(repeatedSpace);
      assertStyledCharacters(styledCharacters(repeatedSpace), theme, "toolDiffAdded", "+abcdefghijkl", [" "]);
    });
    await app.session.prompt("/tree-versioning-diff");
    view.verify();
  } finally { dispose(app.session); }
});

for (const [mode, palette] of [["regular", "dark"], ["fullscreen", "light"]] as const) {
  test(`${mode} keeps inline emphasis on the right characters after wrapping in the ${palette} theme`, async () => {
    const workspace = await fixture();
    const path = join(workspace.cwd, "notes.txt");
    const oldValue = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥👩‍💻e\u0301";
    const newValue = "春夏秋冬东西南北红黄蓝绿上下左右山川江海昼夜👩‍🔬e\u0300";
    await writeFile(path, `值=${oldValue};尾\n`);
    const view = viewFixture(mode);
    view.terminal.columns = 80;
    view.terminal.rows = 96;
    initTheme(palette, false);
    const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
    const theme = app.session.extensionRunner.getUIContext().theme;
    view.setTheme(theme);
    try {
      await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
      await writeFile(path, `值=${newValue};尾\n`);
      await app.session.prompt("Change a long value containing wide and combined characters.");
      view.inspect(() => {
        assert.ok(view.screenLines().every(line => !stripVTControlCharacters(line).includes("值=")));
        view.sendKey("\x0f");
        for (const width of [80, 14]) {
          view.resize(width, 96);
          const seen = new Set<string>();
          for (let scroll = 0; scroll < 80 && seen.size < 2; scroll++) {
            const screen = view.screenLines();
            const plain = screen.map(line => stripVTControlCharacters(line).trimEnd());
            assert.ok(screen.every(line => visibleWidth(line) <= width));
            for (const [sign, value, color] of [["-", oldValue, "toolDiffRemoved"], ["+", newValue, "toolDiffAdded"]] as const) {
              if (seen.has(sign)) continue;
              const start = plain.findIndex(line => line.startsWith(`${sign}值=`));
              const end = plain.findIndex((line, index) => index >= start && line.endsWith(";尾"));
              if (start < 0 || end < start) continue;
              if (width === 14) assert.ok(end > start, "The changed fragment must wrap across several terminal rows");
              const characters = screen.slice(start, end + 1).flatMap(line => {
                const length = Array.from(stripVTControlCharacters(line).trimEnd()).length;
                return styledCharacters(line).slice(0, length);
              });
              assertStyledCharacters(characters, theme, color, `${sign}值=`, [value], ";尾");
              seen.add(sign);
            }
            if (seen.size < 2) view.sendKey("\x1b[B");
          }
          assert.equal(seen.size, 2, "Both styled patch lines must be reachable through the viewer");
        }
      });
      await app.session.prompt("/tree-versioning-diff");
      view.verify();
      assert.deepEqual(app.errors, []);
    } finally { initTheme("dark", false); dispose(app.session); }
  });
}

async function scrollableFixture(widgetRows: number, mode: "regular" | "fullscreen" = "fullscreen", belowRows = 0) {
  const workspace = await fixture();
  const view = viewFixture(mode, widgetRows, belowRows);
  view.terminal.columns = 80;
  view.terminal.rows = 24;
  const app = await load(workspace, undefined, { mode: "tui", custom: view.custom });
  view.setTheme(app.session.extensionRunner.getUIContext().theme);
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await writeFile(join(workspace.cwd, "notes.txt"), Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n") + "\nFINAL-DIFF-LINE\n");
  await app.session.prompt("Record a scrollable diff.");
  return { app, view };
}

test("fullscreen page keys scroll the focused diff viewer rather than the transcript", async () => {
  const { app, view } = await scrollableFixture(0);
  try {
    let opened = false;
    view.inspect(() => {
      opened = true;
      view.sendKey("\x0f");
      const patchLines = () => view.screenLines().flatMap(line => stripVTControlCharacters(line).match(/\+line-\d+/g) ?? []);
      view.sendKey("\x1b[6~");
      const before = patchLines();
      const transcript = () => view.screenLines().map(stripVTControlCharacters).filter(line => line.startsWith("Transcript"));
      const beforeTranscript = transcript();
      assert.ok(before.length > 0, view.screenLines().map(stripVTControlCharacters).join("\n"));
      view.sendKey("\x1b[6~");
      assert.notDeepEqual(patchLines(), before, "Page Down must reach the viewer through terminal dispatch");
      assert.deepEqual(transcript(), beforeTranscript);
      assert.match(view.screenLines().map(stripVTControlCharacters).join("\n"), /pageUp\/pageDown\s+page/,
        "The complete key guide should stay pinned when two rows fit comfortably");
      view.sendKey("\x1b[5~");
      assert.deepEqual(patchLines(), before);
    });
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(opened, true);
    view.verify();
  } finally { dispose(app.session); }
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} keeps help visible and pages through every line with widgets above and below the input`, async () => {
    const { app, view } = await scrollableFixture(12, mode, 4);
    try {
      view.keybindings.setUserBindings({
        "app.tools.expand": "ctrl+e", "tui.select.cancel": "ctrl+x",
        "tui.select.pageDown": "ctrl+n", "tui.select.pageUp": "ctrl+p",
      });
      view.inspect(component => {
        view.sendKey("\x05");
        for (const [columns, rows] of [[80, 24], [24, 12], [100, 30]]) {
          view.resize(columns, rows);
          for (let page = 0; page < 250; page++) view.sendKey("\x10");
          const seen = new Set<number>();
          let reachedEnd = false;
          for (let page = 0; page < 250; page++) {
            const screen = view.screenLines().map(stripVTControlCharacters).join("\n");
            assert.match(screen, /ctrl\+x close/, "Closing help must remain visible beside the dock widgets");
            for (const match of screen.matchAll(/\+line-(\d+)/g)) seen.add(Number(match[1]));
            if (screen.includes("FINAL-DIFF-LINE")) { reachedEnd = true; break; }
            view.sendKey("\x0e");
          }
          assert.equal(reachedEnd, true);
          assert.equal(seen.size, 100, "Paging must not skip lines clipped by the host dock");
          assert.ok(component.render(columns).length <= Math.floor(rows / 2));
          assert.ok(view.screenLines().every(line => visibleWidth(line) <= columns));
          assert.equal(view.hasOverlay(), false);
        }
        view.sendKey("\x18");
      });
      await app.session.prompt("/tree-versioning-diff");
      view.verify();
      assert.deepEqual(app.errors, []);
    } finally { dispose(app.session); }
  });
}

for (const mode of ["regular", "fullscreen"] as const) for (const remapped of [false, true]) {
  test(`${mode} retains a complete close instruction at 12 columns with ${remapped ? "remapped" : "default"} keys`, async () => {
    const { app, view } = await scrollableFixture(0, mode);
    try {
      if (remapped) view.keybindings.setUserBindings({ "tui.select.cancel": ["ctrl+shift+x", "ctrl+x"] });
      view.inspect(() => {
        view.resize(12, 12);
        view.sendKey("\x0f");
        for (let page = 0; page < 30; page++) {
          view.sendKey("\x1b[6~");
          assert.match(view.screenLines().map(stripVTControlCharacters).join("\n"),
            remapped ? /ctrl\+x close/ : /escape close/);
        }
        view.sendKey(remapped ? "\x18" : "\x1b");
      });
      await app.session.prompt("/tree-versioning-diff");
      view.verify();
      assert.deepEqual(app.errors, []);
    } finally { dispose(app.session); }
  });
}

for (const widgetRows of [0, 4, 12]) {
  test(`fullscreen diff scrolling reaches the last line alongside ${widgetRows} dock widget rows`, async () => {
    const { app, view } = await scrollableFixture(widgetRows);
    try {
      let opened = false;
      view.inspect(() => {
        opened = true;
        view.sendKey("\x0f");
        for (let line = 0; line < 150; line++) view.sendKey("\x1b[B");
        assert.match(view.screenLines().map(stripVTControlCharacters).join("\n"), /FINAL-DIFF-LINE/);
        view.resize(24, 12);
        for (let page = 0; page < 200 && !view.screenLines().some(line => line.includes("FINAL-DIFF-LINE")); page++) {
          view.sendKey("\x1b[6~");
        }
        assert.match(view.screenLines().map(stripVTControlCharacters).join("\n"), /FINAL-DIFF-LINE/);
        assert.ok(view.screenLines().every(line => visibleWidth(line) <= 24));
      });
      await app.session.prompt("/tree-versioning-diff");
      assert.equal(opened, true);
      view.verify();
    } finally { dispose(app.session); }
  });
}
