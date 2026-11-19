import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { loadRuntime } from "./runtime-fixture.ts";

export function nativeUi(t: TestContext, host: Awaited<ReturnType<typeof loadRuntime>>, mode: "regular" | "fullscreen",
  columns = 120, rows = 36) {
  let interactive: InteractiveMode | undefined;
  t.after(async () => {
    interactive?.stop();
    await host.runtime.dispose();
  });
  return async () => {
    let input: (data: string) => void = () => {};
    let resize: () => void = () => {};
    let output = "";
    const terminal: Terminal & { columns: number; rows: number } = {
      columns, rows, kittyProtocolActive: false,
      start(onInput, onResize) { input = onInput; resize = onResize; },
      stop() {}, async drainInput() {}, write(data) { output += data; }, moveBy() {},
      hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
      setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    interactive = new InteractiveMode(host.runtime, { terminal, tuiMode: mode, initialThemeSetting: "dark" });
    await interactive.init();
    const ui = host.app.session.extensionRunner.getUIContext();
    let renderer: TuiAltScreen | TuiMainScreen | undefined;
    ui.setWidget("test-observer", tui => {
      assert.ok(tui instanceof TuiAltScreen || tui instanceof TuiMainScreen);
      renderer = tui;
      return new Text("", 0, 0);
    });
    assert.ok(renderer);
    const activeRenderer = renderer;
    return {
      ui, input,
      get output() { return stripVTControlCharacters(output); },
      hasOverlay: () => activeRenderer.hasOverlay(),
      screen() {
        activeRenderer.renderNow();
        const lines = activeRenderer instanceof TuiAltScreen ? activeRenderer.getScreenLines() :
          activeRenderer.captureRenderState().previousLines.slice(-terminal.rows);
        return lines.map(stripVTControlCharacters).join("\n");
      },
      resize(columns: number, rows: number) {
        terminal.columns = columns;
        terminal.rows = rows;
        resize();
        activeRenderer.renderNow(true);
      },
    };
  };
}
