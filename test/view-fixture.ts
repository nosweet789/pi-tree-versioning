import assert from "node:assert/strict";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import {
  Container, getKeybindings, setKeybindings, Text, TuiAltScreen, TuiMainScreen,
  type Component, type OverlayHandle, type Terminal,
} from "@earendil-works/pi-tui";

export function viewFixture(mode: "regular" | "fullscreen" = "regular", widgetRows = 0) {
  let input: (data: string) => void = () => {};
  let resize: () => void = () => {};
  const terminal: Terminal & { columns: number; rows: number } = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start(onInput, onResize) { input = onInput; resize = onResize; },
    stop() {}, async drainInput() {}, write() {}, moveBy() {},
    hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const keybindings = new KeybindingsManager();
  let inspect: (component: Component) => void = () => {};
  let theme: Theme;
  let inspectionError: unknown;
  let activeTui: TuiMainScreen | TuiAltScreen | undefined;
  const custom: ExtensionUIContext["custom"] = async (factory, options) => {
    const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
    const previousKeybindings = getKeybindings();
    setKeybindings(keybindings);
    activeTui = tui;
    const editor = new Container();
    editor.addChild(new Text("Editor", 0, 0));
    const document = new Text(Array.from({ length: 60 }, (_, index) => `Transcript ${index}`).join("\n"), 0, 0);
    const widgetsAbove = new Text(Array.from({ length: widgetRows }, () => "Extension widget").join("\n"), 0, 0);
    const footer = new Text("Footer", 0, 0);
    if (tui instanceof TuiAltScreen) {
      tui.setLayoutRoot(createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
        widgetsAbove, editor, footer, scrollbar: "hidden" }).root);
    } else {
      for (const child of [document, widgetsAbove, editor, footer]) tui.addChild(child);
    }
    let overlay: OverlayHandle | undefined;
    let component: (Component & { dispose?(): void }) | undefined;
    try {
      tui.start();
      let closed = false;
      return await new Promise((resolve, reject) => {
        Promise.resolve(factory(tui, theme, keybindings, result => {
          closed = true;
          overlay?.hide();
          editor.clear();
          editor.addChild(new Text("Editor", 0, 0));
          tui.setFocus(editor);
          resolve(result);
        })).then(created => {
          component = created;
          if (options?.overlay) {
            const overlayOptions = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            overlay = tui.showOverlay(component, overlayOptions);
          } else {
            editor.clear();
            editor.addChild(component);
            tui.setFocus(component);
          }
          tui.renderNow();
          try { inspect(component); } catch (error) { inspectionError = error; }
          input("\x1b");
          assert.equal(closed, true, "Escape must close the read-only viewer");
        }).catch(error => { inspectionError = error; reject(error); });
      });
    } finally {
      component?.dispose?.();
      tui.stop();
      activeTui = undefined;
      setKeybindings(previousKeybindings);
    }
  };
  return {
    custom, terminal, keybindings,
    setTheme(value: Theme) { theme = value; },
    inspect(callback: typeof inspect) { inspect = callback; inspectionError = undefined; },
    verify() { if (inspectionError) throw inspectionError; },
    sendKey(data: string) { input(data); activeTui?.renderNow(); },
    resize(columns: number, rows: number) { terminal.columns = columns; terminal.rows = rows; resize(); activeTui?.renderNow(true); },
    screenLines() {
      assert.ok(activeTui instanceof TuiAltScreen, "Screen inspection requires the real fullscreen renderer");
      return activeTui.getScreenLines();
    },
  };
}
