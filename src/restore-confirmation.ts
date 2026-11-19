import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, TuiAltScreen, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { Language } from "./language.ts";

function visibleLines(tui: TUI) {
  if (tui instanceof TuiAltScreen) return tui.getScreenLines();
  if (tui instanceof TuiMainScreen) {
    const { previousLines, previousViewportTop, previousHeight } = tui.captureRenderState();
    return previousLines.slice(previousViewportTop, previousViewportTop + previousHeight);
  }
  return [];
}

export async function confirmFileRestore(ctx: ExtensionContext, language: Language, target: string) {
  const title = language.message("restoreHereTitle");
  const body = target + "\n" + language.message("restoreHereRisk");
  if (ctx.mode !== "tui") return ctx.ui.confirm(title, body);

  // Use the editor slot, not an overlay: transcript graphics can obscure
  // overlays even when their text is present in Pi's rendered frame.
  // Require an explicit key and verify the warning wasn't clipped by the dock.
  return ctx.ui.custom<boolean | undefined>((tui, theme, keybindings, done) => {
    const text = new Text("", 1, 1, line => theme.bg("selectedBg", line));
    const cancel = keybindings.getKeys("tui.select.cancel").join("/");
    const approve = (["y", "r", "a"] as const).find(key => !keybindings.matches(key, "tui.select.cancel"));
    if (!approve) done(undefined);
    let shown: { columns: number; rows: number; lines: string[] } | undefined;
    const warningVisible = () => {
      const frame = shown;
      if (!frame || frame.columns !== tui.terminal.columns || frame.rows !== tui.terminal.rows) return false;
      const screen = visibleLines(tui).map(stripVTControlCharacters);
      return screen.some((_, index) => frame.lines.every((line, offset) => screen[index + offset]?.includes(line)));
    };
    return {
      render(width) {
        shown = undefined;
        const { columns, rows } = tui.terminal;
        if (width >= 8) {
          text.setText(theme.fg("warning", theme.bold(title)) + "\n" + body + "\n\n" +
            theme.fg("accent", language.message("restoreHereKeys", { approve: approve ?? "", cancel })));
          const lines = text.render(width);
          if (lines.length <= rows) {
            shown = { columns, rows, lines: lines.map(line => stripVTControlCharacters(line).trim()) };
            return lines;
          }
        }
        return [truncateToWidth(language.message("restoreHereResize"), width)];
      },
      handleInput(key) {
        if (keybindings.matches(key, "tui.select.cancel")) done(false);
        else if (approve && matchesKey(key, approve) && warningVisible()) done(true);
      },
      invalidate() { shown = undefined; text.invalidate(); },
      dispose() { done(false); },
    };
  }, { blocked: { kind: "permission", message: title } });
}
