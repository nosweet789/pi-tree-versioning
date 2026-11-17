import type { EntryRenderOptions, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RecordedDiff, SessionFiles } from "./session-files.ts";
import type { Language, MessageKey } from "./language.ts";
import { errorCodes } from "./errors.ts";
import { comparisonOutput } from "./tool-contract.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";

type Comparison = Awaited<ReturnType<SessionFiles["diff"]>>;
const diffCardSchema = Type.Union([comparisonOutput, Type.Object({
  status: Type.Literal("error"), checkpointId: Type.String(), code: Type.Union(errorCodes.map(code => Type.Literal(code))),
})]);

// Escape terminal instructions without changing the stored paths or patches.
export function terminalText(value: string, multiline = false): string {
  const controls = multiline ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g;
  return value.replace(controls, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function panelHeight(tui: TUI, viewer: Component, width: number): number {
  const containsViewer = (component: Component): boolean => component === viewer ||
    (component instanceof Container && component.children.some(containsViewer));
  // Pi mounts the transcript first, followed by dock components, in both modes.
  // Reserve their natural heights so fullscreen never clips our scrolling viewport.
  const dockHeight = tui.children.slice(1).filter(component => !containsViewer(component))
    .reduce((height, component) => height + component.render(width).length, 0);
  return Math.max(0, Math.min(Math.floor(tui.terminal.rows / 2), Math.max(2, tui.terminal.rows - dockHeight - 1)));
}

export async function showDiff(comparison: Comparison, language: Language, ctx: ExtensionContext) {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let expanded = false;
    const options: EntryRenderOptions = {
      get expanded() { return expanded; },
      keyText: key => keybindings.getKeys(key).join("/"),
      keyHint: (key, description) => keybindings.getKeys(key).join("/") + " " + description,
    };
    const content = diffView(comparison, language, options, theme);
    const scroll = new ScrollView(content, { scrollbar: "hidden", follow: "none" });
    const viewer: Component = {
      capturesViewportInput: true,
      render(width) {
        const available = panelHeight(tui, viewer, width);
        const help = language.message("viewerKeys", {
          scroll: options.keyText("tui.select.up") + "/" + options.keyText("tui.select.down"),
          page: options.keyText("tui.select.pageUp") + "/" + options.keyText("tui.select.pageDown"),
          expand: options.keyText("app.tools.expand"), close: options.keyText("tui.select.cancel"),
        });
        const helpLines = wrapTextWithAnsi(theme.fg("dim", help), width);
        // Leave most of the panel for the diff. In cramped layouts, keep close help
        // pinned and put the complete key guide at the start of the scrollable content.
        const compactHelp = helpLines.length > Math.max(1, Math.floor(available / 3));
        const closeHints = keybindings.getKeys("tui.select.cancel").map(close => language.message("viewerClose", { close }));
        const closeHint = closeHints.find(hint => visibleWidth(hint) <= width) ?? closeHints[0] ?? "";
        const footer = compactHelp ? [truncateToWidth(theme.fg("dim", closeHint), width)] : helpLines;
        const lines = [...(compactHelp ? [...helpLines, ""] : []), ...scroll.render(width)];
        const height = Math.max(0, available - footer.length);
        scroll.updateLayout(lines.length, height, () => tui.requestRender());
        return [...lines.slice(scroll.scrollTop, scroll.scrollTop + height), ...footer].slice(0, available);
      },
      handleInput(data) {
        if (keybindings.matches(data, "tui.select.cancel")) { done(); return; }
        if (keybindings.matches(data, "app.tools.expand")) {
          expanded = !expanded;
          content.invalidate();
          scroll.scrollToStart();
        } else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
        else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
        else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
        else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
        else return;
        tui.requestRender();
      },
      invalidate() { content.invalidate(); },
    };
    return viewer;
  });
}

export function diffView(value: unknown, language: Language, options: EntryRenderOptions, theme: Theme): Component {
  const comparison = Check(diffCardSchema, value) ? value as RecordedDiff : undefined;
  const text = new Text("", 0, 0);
  return {
    render(width) {
      if (!comparison) {
        text.setText(theme.fg("error", language.message("displayUnavailable")));
        return text.render(width);
      }
      if (comparison.status === "error") {
        text.setText(theme.fg("error", language.message("diffFailed", { reason: language.message(comparison.code) })) +
          "\n" + language.message("checkpoint") + " " + terminalText(comparison.checkpointId));
        return text.render(width);
      }
      const endpoint = (value: Comparison["to"]) => value.kind === "workspace" ? terminalText(value.workspaceRoot) :
        language.message(value.kind) + " " + terminalText(value.id) + (value.kind === "checkpoint" ? " · " + terminalText(value.nodeId) : "");
      const lines = [
        theme.fg("accent", theme.bold(language.message(comparison.scope === "session" ? "sessionDiff" : "roundDiff"))),
        theme.fg("border", "─".repeat(Math.max(0, width))),
        theme.fg("muted", language.message("diffFrom", { endpoint: endpoint(comparison.from) })),
        theme.fg("muted", language.message("diffTo", { endpoint: endpoint(comparison.to) })),
      ];
      const coverage = comparison.coverage ?? { searchDepth: 0, repositories: ["."] };
      lines.push(theme.fg("muted", language.message("repositoryCoverage", {
        depth: coverage.searchDepth, repositories: terminalText(JSON.stringify(coverage.repositories)),
      })));
      if (comparison.files.length === 0) lines.push(language.message("noFileChanges"));
      const statuses: Record<string, { label: MessageKey; color: ThemeColor }> = {
        added: { label: "fileAdded", color: "toolDiffAdded" },
        deleted: { label: "fileDeleted", color: "toolDiffRemoved" },
        modified: { label: "fileModified", color: "warning" },
        type_changed: { label: "fileTypeChanged", color: "warning" },
      } as const;
      for (const file of comparison.files) {
        const status = statuses[file.status];
        lines.push(theme.bold(terminalText(file.path)) + " · " + (file.binary ? theme.fg("muted", language.message("binaryFile")) + " · " : "") +
          theme.fg(status.color, language.message(status.label)) + (file.binary ? "" : " · " +
            theme.fg("toolDiffAdded", `+${file.additions}`) + " " + theme.fg("toolDiffRemoved", `-${file.deletions}`)));
        if (options.expanded && file.patch) {
          let inHunk = false;
          for (const line of terminalText(file.patch, true).replace(/\n$/, "").split("\n")) {
            if (line.startsWith("@@")) {
              inHunk = true;
              lines.push(theme.fg("accent", line));
            } else {
              const color = !inHunk ? "muted" : line.startsWith("+") ? "toolDiffAdded" :
                line.startsWith("-") ? "toolDiffRemoved" : line.startsWith(" ") ? "toolDiffContext" : "dim";
              lines.push(theme.fg(color, line));
            }
          }
        }
      }
      if (!options.expanded && comparison.files.some(file => file.patch)) lines.push(theme.fg("dim", options.keyHint("app.tools.expand", language.message("expandDiff"))));
      text.setText(lines.join("\n"));
      return text.render(width);
    },
    invalidate() { text.invalidate(); },
  };
}
