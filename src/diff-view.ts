import type { EntryRenderOptions, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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
function terminalText(value: string, multiline = false): string {
  const controls = multiline ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g;
  return value.replace(controls, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
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
    return {
      render(width) {
        const lines = scroll.render(width);
        const height = Math.max(1, tui.terminal.rows - 4);
        scroll.updateLayout(lines.length, height, () => tui.requestRender());
        const help = language.message("viewerKeys", {
          scroll: options.keyText("tui.select.up") + "/" + options.keyText("tui.select.down"),
          page: options.keyText("tui.select.pageUp") + "/" + options.keyText("tui.select.pageDown"),
          expand: options.keyText("app.tools.expand"), close: options.keyText("tui.select.cancel"),
        });
        return [...lines.slice(scroll.scrollTop, scroll.scrollTop + height), truncateToWidth(theme.fg("dim", help), width)];
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
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } } });
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
        theme.fg("accent", language.message(comparison.scope === "session" ? "sessionDiff" : "roundDiff")),
        language.message("diffFrom", { endpoint: endpoint(comparison.from) }),
        language.message("diffTo", { endpoint: endpoint(comparison.to) }),
      ];
      if (comparison.files.length === 0) lines.push(language.message("noFileChanges"));
      const statuses: Record<string, MessageKey> = { added: "fileAdded", deleted: "fileDeleted", modified: "fileModified", type_changed: "fileTypeChanged" };
      for (const file of comparison.files) {
        lines.push(terminalText(file.path) + " · " + (file.binary ? language.message("binaryFile") + " · " : "") +
          language.message(statuses[file.status]) + (file.binary ? "" : ` · +${file.additions} -${file.deletions}`));
        if (options.expanded && file.patch) lines.push(terminalText(file.patch, true));
      }
      if (!options.expanded && comparison.files.some(file => file.patch)) lines.push(options.keyHint("app.tools.expand", language.message("expandDiff")));
      text.setText(lines.join("\n"));
      return text.render(width);
    },
    invalidate() { text.invalidate(); },
  };
}
