import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { fixture } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} native custom UI restores the actual editor and keeps browsing read-only`, { timeout: 10_000 }, async () => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace);
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Recorded." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "first saved line\nlast saved line\n");
    await host.app.session.prompt("Record native UI sample.");
    host.app.session.agent.streamFunction = () => { throw new Error("Browsing must not start a model"); };
    let input: (data: string) => void = () => {};
    let output = "";
    const terminal: Terminal = {
      columns: 100, rows: 30, kittyProtocolActive: false,
      start(onInput) { input = onInput; },
      stop() {}, async drainInput() {}, write(data) { output += data; }, moveBy() {},
      hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
      setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const interactive = new InteractiveMode(host.runtime, { terminal, tuiMode: mode, initialThemeSetting: "dark" });
    try {
      await interactive.init();
      const ui = host.app.session.extensionRunner.getUIContext();
      let renderer: TuiAltScreen | TuiMainScreen | undefined;
      ui.setWidget("test-observer", tui => {
        assert.ok(tui instanceof TuiAltScreen || tui instanceof TuiMainScreen);
        renderer = tui;
        return new Text("Above input", 0, 0);
      });
      ui.setWidget("test-below", ["Below input"], { placement: "belowEditor" });
      ui.setFooter(() => new Text("Native footer", 0, 0));
      assert.ok(renderer);
      const activeRenderer = renderer;
      const screen = () => {
        activeRenderer.renderNow();
        return (activeRenderer instanceof TuiAltScreen ? activeRenderer.getScreenLines() :
          activeRenderer.captureRenderState().previousLines.slice(-terminal.rows)).map(stripVTControlCharacters).join("\n");
      };
      ui.setEditorText("Original input\nUnsubmitted second line");
      const entries = host.app.manager.getEntries();
      const comparison = (await host.app.diff({ scope: "session" })).details;
      const pending = host.app.session.prompt("/tree-versioning-diff");
      try {
        for (let attempt = 0; attempt < 200 && !screen().includes("Saved session diff"); attempt++) await setTimeout(5);
        assert.match(screen(), /Saved session diff/);
        assert.equal(renderer.hasOverlay(), false);
        assert.doesNotMatch(screen(), /Unsubmitted second line/);
        input("\x0f");
        assert.match(screen(), /\+last saved line/);
        assert.match(screen(), /Below input[\s\S]*Native footer/);
      } finally {
        input("\x1b");
        await pending;
      }
      assert.equal(ui.getEditorText(), "Original input\nUnsubmitted second line");
      assert.match(screen(), /Unsubmitted second line/);
      assert.doesNotMatch(screen(), /Saved session diff/);
      input("!");
      assert.equal(ui.getEditorText(), "Original input\nUnsubmitted second line!");
      assert.deepEqual(host.app.manager.getEntries(), entries);
      assert.deepEqual((await host.app.diff({ scope: "session" })).details, comparison);
      assert.match(stripVTControlCharacters(output), /Saved session diff/);
    } finally {
      interactive.stop();
      await host.runtime.dispose();
    }
  });
}
