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

async function fullscreenFixture(widgetRows: number) {
  const workspace = await fixture();
  const view = viewFixture("fullscreen", widgetRows);
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
  const { app, view } = await fullscreenFixture(0);
  try {
    let opened = false;
    view.inspect(() => {
      opened = true;
      view.sendKey("\x0f");
      const patchLines = () => view.screenLines().flatMap(line => stripVTControlCharacters(line).match(/\+line-\d+/g) ?? []);
      const before = patchLines();
      assert.ok(before.length > 0, view.screenLines().map(stripVTControlCharacters).join("\n"));
      view.sendKey("\x1b[6~");
      assert.notDeepEqual(patchLines(), before, "Page Down must reach the viewer through terminal dispatch");
      view.sendKey("\x1b[5~");
      assert.deepEqual(patchLines(), before);
    });
    await app.session.prompt("/tree-versioning-diff");
    assert.equal(opened, true);
    view.verify();
  } finally { dispose(app.session); }
});

for (const widgetRows of [0, 4, 12]) {
  test(`fullscreen diff scrolling reaches the last line alongside ${widgetRows} dock widget rows`, async () => {
    const { app, view } = await fullscreenFixture(widgetRows);
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
