import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { diffOutput, diffParameters } from "./tool-contract.ts";
export type { DiffInput } from "./tool-contract.ts";
import { SessionFiles, type SessionPosition } from "./session-files.ts";
import { VersioningError } from "./errors.ts";
import { isLanguagePreference, Language } from "./language.ts";
import { exportOutput } from "./tool-output.ts";

function position(ctx: ExtensionContext): SessionPosition {
  return {
    sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    branchIds: ctx.sessionManager.getBranch().map(entry => entry.id),
    entryIds: ctx.sessionManager.getEntries().map(entry => entry.id),
    hasConversation: ctx.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role !== "system" || entry.type === "custom_message"),
    hasBaselineRecord: ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline"),
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default async function treeVersioning(pi: ExtensionAPI) {
  const storage = join(getAgentDir(), "tree-versioning");
  const files = new SessionFiles(storage);
  let activeWorkspaceRoot: string | undefined;
  const language = new Language(join(storage, "preferences.json"));
  let preferenceError: unknown;
  try { await language.load(); } catch (error) { preferenceError = error; }

  const registerLanguageCommand = () => pi.registerCommand("tree-versioning-language", {
    description: language.message("languageCommand"),
    getArgumentCompletions: prefix => ["en", "zh-CN", "auto"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (!isLanguagePreference(choice)) {
        notify(ctx, language.message("languageHelp", { preference: language.preference }), "info");
        return;
      }
      try {
        await language.save(choice);
        registerLanguageCommand();
        notify(ctx, language.message("languageSaved", { preference: choice }), "info");
      } catch (error) {
        notify(ctx, language.message("preferences_failed") + " " + String(error), "error");
      }
    },
  });
  registerLanguageCommand();
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(current => {
        const cachedDescription = language.message("languageCommand");
        return {
          triggerCharacters: current.triggerCharacters,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
            if (!suggestions?.prefix.startsWith("/") || suggestions.prefix.includes(" ")) return suggestions;
            return {
              ...suggestions,
              items: suggestions.items.map(item => /^tree-versioning-language(?::\d+)?$/.test(item.value)
                ? { ...item, description: item.description?.replace(cachedDescription, language.message("languageCommand")) }
                : item),
            };
          },
          applyCompletion: (...args) => current.applyCompletion(...args),
          shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
        };
      });
    }
    if (preferenceError) notify(ctx, language.message("preferences_failed") + " " + String(preferenceError), "error");
    try {
      const { baseline, created, workspaceRoot } = await files.initialize(position(ctx));
      activeWorkspaceRoot = workspaceRoot;
      if (created) {
        pi.appendEntry("tree-versioning.baseline", baseline);
        notify(ctx, language.message("baselineCreated"), "info");
      }
    } catch (error) {
      const reason = error instanceof VersioningError ? language.message(error.code) : String(error);
      notify(ctx, language.message("startupFailed", { reason }), "error");
    }
  });
  pi.registerTool({
    name: "session_diff", get label() { return language.message("diffLabel"); },
    description: "Read unsnapshotted changes from the session baseline to the disk workspace. Text is limited to 2000 lines / 50 KiB; larger comparisons are exported to a private temporary JSON file, not a checkpoint.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: diffParameters,
    outputSchema: diffOutput,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        if (params.scope !== undefined && params.scope !== "workspace") {
          throw new VersioningError("unsupported_scope", "Only workspace comparisons are available.");
        }
        const comparison = await files.diff(position(ctx), params.files);
        const fullText = JSON.stringify(comparison, null, 2);
        const bounded = truncateHead(fullText);
        let output: { truncated: true; fullOutputPath: string; totalFiles: number } | undefined;
        let text = language.message("comparison", { count: comparison.files.length }) + "\n" + bounded.content;
        if (bounded.truncated) {
          const fullOutputPath = await exportOutput(fullText, comparison.to.workspaceRoot, "comparison.json");
          output = { truncated: true, fullOutputPath, totalFiles: comparison.files.length };
          text += "\n" + language.message("outputTruncated", { path: fullOutputPath });
        }
        const { files: _fileChanges, ...comparisonEndpoints } = comparison;
        const details = output ? { ...comparisonEndpoints, output } : comparison;
        return { content: [{ type: "text" as const, text }], details, structuredContent: details };
      } catch (error) {
        const rawDiagnostic = error instanceof Error ? error.message : String(error);
        const diagnostic = truncateHead(rawDiagnostic, { maxBytes: 32 * 1024, maxLines: 1500 });
        let diagnosticExport: { diagnosticPath: string } | { diagnosticExportFailed: true } | undefined;
        if (diagnostic.truncated) {
          try { diagnosticExport = { diagnosticPath: await exportOutput(rawDiagnostic, activeWorkspaceRoot, "diagnostic.txt") }; }
          catch { diagnosticExport = { diagnosticExportFailed: true }; }
        }
        const details = {
          status: "error" as const,
          code: error instanceof VersioningError ? error.code : "query_failed" as const,
          diagnostic: diagnostic.content,
          diagnosticTruncated: diagnostic.truncated,
          ...diagnosticExport,
        };
        const notice = diagnosticExport && "diagnosticPath" in diagnosticExport
          ? language.message("diagnosticTruncated", { path: diagnosticExport.diagnosticPath })
          : diagnosticExport ? language.message("diagnosticExportFailed") : "";
        const text = language.message(details.code) + "\n" + details.diagnostic + (notice ? "\n" + notice : "");
        return { isError: true, content: [{ type: "text" as const, text }], details, structuredContent: details };
      }
    },
  });
}
