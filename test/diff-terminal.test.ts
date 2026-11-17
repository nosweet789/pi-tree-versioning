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
        for (let page = 0; page < 20; page++) view.sendKey("\x1b[6~");
        assert.match(view.screenLines().map(stripVTControlCharacters).join("\n"), /FINAL-DIFF-LINE/);
        assert.ok(view.screenLines().every(line => visibleWidth(line) <= 24));
      });
      await app.session.prompt("/tree-versioning-diff");
      assert.equal(opened, true);
      view.verify();
    } finally { dispose(app.session); }
  });
}
