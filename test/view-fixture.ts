import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { CustomEntry, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import {
  Container, getKeybindings, Input, setKeybindings, Text, TuiAltScreen, TuiMainScreen,
  type Component, type OverlayHandle, type Terminal,
} from "@earendil-works/pi-tui";
import type { TestApp } from "./agent-fixture.ts";

export function historyCards(app: TestApp) {
  return app.manager.getEntries().filter((entry): entry is CustomEntry =>
    entry.type === "custom" && !!app.session.extensionRunner.getEntryRenderer(entry.customType));
}

export function renderPlainText(component: Component, width: number) {
  return component.render(width).map(line => stripVTControlCharacters(line).trimEnd()).join("\n");
}

export function renderedHistoryCards(app: TestApp) {
  return historyCards(app).map(entry => {
    const renderer = app.session.extensionRunner.getEntryRenderer(entry.customType)!;
    return renderPlainText(new CustomEntryComponent(entry, renderer), 120);
  });
}

export function viewFixture(mode: "regular" | "fullscreen" = "regular", widgetRows = 0, belowRows = 0) {
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
    const draft = new Input();
    draft.setValue("Unsubmitted draft");
    editor.addChild(draft);
    const document = new Text(Array.from({ length: 60 }, (_, index) => `Transcript ${index}`).join("\n"), 0, 0);
    const widgetsAbove = new Text(Array.from({ length: widgetRows }, () => "Extension widget").join("\n"), 0, 0);
    const widgetsBelow = new Text(Array.from({ length: belowRows }, () => "Below editor widget").join("\n"), 0, 0);
    const footer = new Text("Footer", 0, 0);
    // The host mounts the same ordered components in both renderers.
    for (const child of [document, widgetsAbove, editor, widgetsBelow, footer]) tui.addChild(child);
    if (tui instanceof TuiAltScreen) {
      tui.setLayoutRoot(createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
        widgetsAbove, editor, widgetsBelow, footer, scrollbar: "hidden" }).root);
    }
    tui.setFocus(draft);
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
          editor.addChild(draft);
          tui.setFocus(draft);
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
          if (!closed) input("\x1b");
          assert.equal(closed, true, "The configured cancel key must close the read-only viewer");
          tui.renderNow();
          assert.equal(draft.getValue(), "Unsubmitted draft");
          assert.equal(draft.focused, true);
          input("!");
          assert.equal(draft.getValue(), "!Unsubmitted draft", "Typing must return to the original input");
          assert.equal(tui.hasOverlay(), false);
        }).catch(error => { inspectionError ??= error; reject(error); });
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
    hasOverlay() { return activeTui?.hasOverlay() ?? false; },
    screenLines() {
      assert.ok(activeTui, "Screen inspection requires an open viewer");
      return activeTui instanceof TuiAltScreen ? activeTui.getScreenLines() :
        activeTui.captureRenderState().previousLines.slice(-terminal.rows);
    },
  };
}
