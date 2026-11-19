import type { EntryRenderOptions, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RecordedDiff, RoundDiffPreview, SessionFiles } from "./session-files.ts";
import type { Language, MessageKey } from "./language.ts";
import { errorCodes } from "./errors.ts";
import { comparisonOutput } from "./tool-contract.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { formatPatch } from "diff";
import { createInlineDiffer, type InlineSpan } from "./inline-diff.ts";

export const diffCommandName = "tree-versioning-diff";
export const roundDiffArgument = "round";

type Comparison = Awaited<ReturnType<SessionFiles["diff"]>>;
const diffCardSchema = Type.Union([comparisonOutput, Type.Object({
  status: Type.Literal("error"), checkpointId: Type.String(), code: Type.Union(errorCodes.map(code => Type.Literal(code))),
})]);

// Escape terminal instructions without changing the stored paths or patches.
export function terminalText(value: string, multiline = false): string {
  const controls = multiline ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g;
  return value.replace(controls, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

type InlineDiffer = ReturnType<typeof createInlineDiffer>;
const inlineDiffs = new WeakMap<Comparison, InlineDiffer>();

function inlineDiffer(comparison: Comparison): InlineDiffer {
  // Pi can recreate a card component on invalidation. Keep only unstyled diffs
  // with the recorded comparison so the budget and results survive that rebuild.
  let differ = inlineDiffs.get(comparison);
  if (!differ) {
    differ = createInlineDiffer();
    inlineDiffs.set(comparison, differ);
  }
  return differ;
}

const patchGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function keepsHighlightedSpace(wrapped: string[], plain: string, display: InlineSpan[]) {
  const spaces: number[] = [];
  let offset = 0;
  for (const span of display) {
    if (span.changed) {
      for (const match of span.text.matchAll(/\s/gu)) spaces.push(offset + match.index);
    }
    offset += span.text.length;
  }
  const rows = wrapped.map(stripTerminalSequences).filter(Boolean);
  const latestStarts: number[] = [];
  let limit = plain.length;
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = rows[index];
    if (limit < text.length) return false;
    limit = plain.lastIndexOf(text, limit - text.length);
    if (limit < 0) return false;
    latestStarts[index] = limit;
  }
  // Repeated spaces can match either side of a wrap. Only count positions
  // retained under both alignments, in the same row.
  let space = 0, earliestEnd = 0;
  for (const [index, text] of rows.entries()) {
    const start = plain.indexOf(text, earliestEnd);
    if (start < 0 || spaces[space] < latestStarts[index]) return false;
    earliestEnd = start + text.length;
    while (spaces[space] < earliestEnd) space++;
  }
  return space === spaces.length;
}

function escapeGlyph(glyph: string, keepSign = false): string {
  const start = keepSign ? glyph[0] : "";
  const escaped = Array.from(glyph.slice(start.length), character => `\\u{${character.codePointAt(0)!.toString(16)}}`).join("");
  return start + escaped;
}

function patchDisplayText(text: string): string {
  return terminalText(text, true).replace(/\t/g, "   ");
}

function fitPatchText(line: string, width: number): string {
  const text = patchDisplayText(line);
  if (!/[^\x20-\x7e]/u.test(text) || visibleWidth(text) <= width) return text;
  let fitted = "";
  for (const { segment, index } of patchGraphemes.segment(text)) {
    const keepSign = index === 0 && (segment[0] === "+" || segment[0] === "-");
    fitted += visibleWidth(segment) > width ? escapeGlyph(segment, keepSign) : segment;
  }
  return fitted;
}

function cutsDisplayGlyph(spans: InlineSpan[], plain: string): boolean {
  const glyphs = patchGraphemes.segment(plain);
  let offset = 0;
  for (const span of spans) {
    if (glyphs.containing(offset)?.index !== offset) return true;
    offset += span.text.length;
  }
  return false;
}

function renderChangedLine(sign: string, spans: InlineSpan[], color: ThemeColor, theme: Theme, width: number): string[] {
  const display = [{ text: sign, changed: false }, ...spans.map(span => ({
    text: patchDisplayText(span.text), changed: span.changed,
  }))];
  const plain = display.map(span => span.text).join("");
  const render = (parts: InlineSpan[]) => parts.map(({ text, changed }) =>
    theme.style(text, { fg: color, bold: changed, underline: changed })).join("");
  const styled = render(display);
  const highlightedSpace = display.some(span => span.changed && /\s/u.test(span.text));
  const nonAscii = /[^\x20-\x7e]/u.test(plain);
  // Escaped controls, expanded tabs, or the line prefix can join adjoining
  // characters into a new grapheme. Wrap it as a whole without moving its styles.
  const splitGlyph = nonAscii && cutsDisplayGlyph(display, plain);
  if (!splitGlyph) {
    if ((!highlightedSpace && !nonAscii) || visibleWidth(plain) <= width) return [styled];
    const wrapped = wrapTextWithAnsi(styled, width);
    if (wrapped.every(line => visibleWidth(line) <= width) &&
        (!highlightedSpace || keepsHighlightedSpace(wrapped, plain, display))) return [styled];
  }

  // Keep Pi's word wrapping where possible. The fallback measures complete glyphs
  // and carries their style to the next row, including right at a column break.
  const rows: string[] = [];
  let row: InlineSpan[] = [], columns = 0;
  const nextRow = () => {
    rows.push(render(row));
    row = [];
    columns = 0;
  };
  const append = (text: string, changed: boolean) => {
    const previous = row.at(-1);
    if (previous?.changed === changed) previous.text += text;
    else row.push({ text, changed });
  };
  let spanIndex = 0, spanEnd = display[0].text.length;
  for (const { segment, index } of patchGraphemes.segment(plain)) {
    const cells = visibleWidth(segment), end = index + segment.length;
    if (cells <= width && columns + cells > width) nextRow();
    for (let offset = index; offset < end;) {
      const { changed } = display[spanIndex];
      const limit = Math.min(spanEnd, end);
      const part = plain.slice(offset, limit);
      if (cells <= width) append(part, changed);
      else {
        // An indivisible glyph cannot fit here. Escape its text, not the diff sign.
        for (const character of escapeGlyph(part, offset === 0)) {
          if (columns === width) nextRow();
          append(character, changed);
          columns++;
        }
      }
      offset = limit;
      if (offset === spanEnd && spanIndex + 1 < display.length) spanEnd += display[++spanIndex].text.length;
    }
    if (cells <= width) columns += cells;
  }
  if (row.length) nextRow();
  return rows;
}

function changeColor(line: string) {
  return line[0] === "-" ? "toolDiffRemoved" : line[0] === "+" ? "toolDiffAdded" : undefined;
}

function* renderPatch(patch: string, path: string, theme: Theme, width: number, inlineDiff: InlineDiffer) {
  // formatPatch writes literal filenames, which can contain line breaks and hunk-like text.
  const header = formatPatch({ oldFileName: "a/" + path, newFileName: "b/" + path,
    oldHeader: undefined, newHeader: undefined, hunks: [] });
  const paint = (line: string, color: ThemeColor) => theme.fg(color, fitPatchText(line, width));
  const hasKnownHeader = patch.startsWith(header);
  for (const line of (hasKnownHeader ? header : patch).replace(/\n$/, "").split("\n")) {
    yield paint(line, "muted");
  }
  if (!hasKnownHeader || patch.length === header.length) return;

  const source = patch.slice(header.length).replace(/\n$/, "").split("\n");
  let inHunk = false;
  for (let start = 0; start < source.length;) {
    const line = source[start];
    if (line.startsWith("@@")) {
      inHunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(line);
      yield paint(line, inHunk ? "accent" : "muted");
      start++;
      continue;
    }
    const firstColor = inHunk ? changeColor(line) : undefined;
    if (!firstColor) {
      const color = !inHunk ? "muted" : line.startsWith(" ") ? "toolDiffContext" : "dim";
      yield paint(line, color);
      start++;
      continue;
    }
    let end = start + 1, secondChange = -1;
    let secondColor: ThemeColor | undefined, overflowColor: ThemeColor | undefined;
    for (; end < source.length; end++) {
      const row = source[end], color = changeColor(row);
      if (color) {
        if (secondColor) { overflowColor = color; break; }
        secondChange = end;
        secondColor = color;
      } else if (row !== "\\ No newline at end of file") break;
    }
    const pair = !overflowColor && firstColor === "toolDiffRemoved" && secondColor === "toolDiffAdded"
      ? inlineDiff(line.slice(1), source[secondChange].slice(1)) : undefined;
    for (let index = start; index < end; index++) {
      const row = source[index];
      const color = index === start ? firstColor : index === secondChange ? secondColor ?? "dim" : "dim";
      const spans = index === start ? pair?.removed : index === secondChange ? pair?.added : undefined;
      if (spans) yield* renderChangedLine(row[0], spans, color, theme, width);
      else yield paint(row, color);
    }
    // Once a third change rules out a pair, color the rest without buffering it.
    if (overflowColor) {
      yield paint(source[end++], overflowColor);
      for (; end < source.length; end++) {
        const row = source[end], color = changeColor(row);
        if (!color && row !== "\\ No newline at end of file") break;
        yield paint(row, color ?? "dim");
      }
    }
    start = end;
  }
}

function remainingDockRows(tui: TUI, panel: Component, width: number): number {
  const containsPanel = (component: Component): boolean => component === panel ||
    (component instanceof Container && component.children.some(containsPanel));
  const height = (component: Component): number => {
    if (component === panel) return 0;
    if (component instanceof Container && component.children.some(containsPanel)) {
      return component.children.reduce((rows, child) => rows + height(child), 0);
    }
    return component.render(width).length;
  };
  // Pi mounts the transcript first, followed by dock components, in both modes.
  // Count other content in the dock, including sibling widgets and the editor
  // slot when it holds a native selector.
  const occupied = tui.children.slice(1).reduce((rows, component) => rows + height(component), 0);
  return tui.terminal.rows - occupied - 1;
}

export async function showDiff(comparison: unknown, language: Language, ctx: ExtensionContext) {
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
        const available = Math.min(Math.floor(tui.terminal.rows / 2), Math.max(2, remainingDockRows(tui, viewer, width)));
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

type DiffViewOptions = Pick<EntryRenderOptions, "expanded"> & Partial<Pick<EntryRenderOptions, "keyHint">>;

export function setRoundDiffPreview(ctx: ExtensionContext, language: Language, preview?: RoundDiffPreview) {
  const widget = preview && ((tui: TUI, theme: Theme): Component => {
    const content = diffView(preview.diff, language, { get expanded() { return ctx.ui.getToolsExpanded(); } }, theme);
    let measuring = false;
    const panel: Component = {
      render(width) {
        if (width < 1 || measuring || ctx.sessionManager.getLeafId() !== preview.nodeId) return [];
        // Other widgets can also measure the dock. Do not recurse via theirs.
        measuring = true;
        let height: number;
        try { height = Math.min(Math.floor(tui.terminal.rows / 2), remainingDockRows(tui, panel, width)); }
        finally { measuring = false; }
        if (height < 1) return [];
        let lines = content.render(width);
        if (lines.length > height) {
          if (!content.hasComparison) {
            const error = theme.fg("error", language.message("diffUnavailableTitle"));
            lines = [error, ...lines.slice(0, height - 1)];
          } else if (height > 1) {
            const command = `/${diffCommandName} ${roundDiffArgument}`;
            const label = command + " " + language.message("roundDiffFullView");
            // An incomplete command would open the session diff instead.
            const hint = visibleWidth(label) <= width ? label :
              command.length <= width ? command : language.message("roundDiffWiden");
            lines = [lines[0], theme.fg("dim", hint), ...lines.slice(1, height - 1)];
          }
        }
        return lines.slice(0, height).map(line => truncateToWidth(line, width));
      },
      invalidate() { content.invalidate(); },
    };
    return panel;
  });
  ctx.ui.setWidget("tree-versioning.round-diff", widget);
}

function fileChangeSummary(files: Comparison["files"], language: Language): string {
  const counts = { modified: 0, added: 0, deleted: 0 };
  for (const { status } of files) {
    switch (status) {
      case "modified":
      case "type_changed": counts.modified++; break;
      case "added": counts.added++; break;
      case "deleted": counts.deleted++; break;
    }
  }

  const changes: string[] = [];
  if (counts.modified) changes.push(language.message("filesModifiedCount", { count: counts.modified }));
  if (counts.added) changes.push(language.message("filesAddedCount", { count: counts.added }));
  if (counts.deleted) changes.push(language.message("filesDeletedCount", { count: counts.deleted }));
  return language.message(files.length === 1 ? "oneFileChanged" : "filesChanged", {
    count: files.length, changes: changes.join(language.message("fileChangeSeparator")),
  });
}

export function diffView(value: unknown, language: Language, options: DiffViewOptions, theme: Theme): Component & { hasComparison: boolean } {
  const comparison = Check(diffCardSchema, value) ? value as RecordedDiff : undefined;
  const text = new Text("", 0, 0);
  let patchLayout: { width: number; files: Map<string, string> } | undefined;
  return {
    hasComparison: comparison?.status === "ok",
    render(width) {
      if (width < 1) return [];
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
      else if (comparison.scope === "turn" || comparison.scope === "session") {
        lines.push(fileChangeSummary(comparison.files, language));
      }
      const inlineDiff = options.expanded ? inlineDiffer(comparison) : undefined;
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
        if (inlineDiff && file.patch) {
          if (patchLayout?.width !== width) patchLayout = { width, files: new Map() };
          let rendered = patchLayout.files.get(file.path);
          if (rendered === undefined) {
            rendered = [...renderPatch(file.patch, file.path, theme, width, inlineDiff)].join("\n");
            patchLayout.files.set(file.path, rendered);
          }
          lines.push(rendered);
        }
      }
      if (!inlineDiff && comparison.files.some(file => file.patch)) {
        const hint = options.keyHint?.("app.tools.expand", language.message("expandDiff")) ?? language.message("roundDiffExpand");
        lines.push(theme.fg("dim", hint));
      }
      text.setText(lines.join("\n"));
      return text.render(width);
    },
    invalidate() { patchLayout = undefined; text.invalidate(); },
  };
}
