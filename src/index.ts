import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { checkpointsOutput, checkpointsParameters, diffOutput, diffParameters } from "./tool-contract.ts";
export type { CheckpointsInput, DiffInput } from "./tool-contract.ts";
import { SessionFiles, type SessionPosition } from "./session-files.ts";
import { VersioningError } from "./errors.ts";
import { isLanguagePreference, Language } from "./language.ts";
import { exportOutput } from "./tool-output.ts";
import { diffView, showDiff } from "./diff-view.ts";

function position(ctx: ExtensionContext): SessionPosition {
  return {
    sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    entries: ctx.sessionManager.getEntries(),
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

// Unlike informational notifications, failures must also reach the non-UI host error channel.
function reportError(ctx: ExtensionContext, message: string) {
  if (!ctx.hasUI) throw new Error(message);
  ctx.ui.notify(message, "error");
}

export default async function treeVersioning(pi: ExtensionAPI) {
  const storage = join(getAgentDir(), "tree-versioning");
  const files = new SessionFiles(storage);
  let activeWorkspaceRoot: string | undefined;
  let restoreGeneration = 0;
  let active = true;
  pi.on("session_before_fork", async (event, ctx) => {
    try { await files.prepareFork(position(ctx), event.entryId, event.position); }
    catch { reportError(ctx, language.message("inheritanceFailed")); }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    active = false;
    restoreGeneration++;
    if (event.reason === "fork") {
      try { await files.finishFork(position(ctx), event.targetSessionFile); }
      catch { reportError(ctx, language.message("inheritanceFailed")); }
    }
  });
  pi.on("before_agent_start", () => { restoreGeneration++; });
  const language = new Language(join(storage, "preferences.json"));
  let preferenceError: unknown;
  try { await language.load(); } catch (error) { preferenceError = error; }

  const registerDiffCommand = () => pi.registerCommand("tree-versioning-diff", {
    description: language.message("diffCommand"),
    handler: async (args, ctx) => {
      if (args.trim()) {
        notify(ctx, language.message("diffHelp"), "info");
        return;
      }
      if (ctx.mode !== "tui") {
        reportError(ctx, language.message("viewerRequiresTui"));
        return;
      }
      try {
        const comparison = await files.diff(position(ctx), { scope: "session" });
        await showDiff(comparison, language, ctx);
      } catch (error) {
        const reason = error instanceof VersioningError ? language.message(error.code) : language.message("query_failed") + " " + String(error);
        notify(ctx, reason, "error");
      }
    },
  });
  registerDiffCommand();
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
        registerDiffCommand();
        notify(ctx, language.message("languageSaved", { preference: choice }), "info");
      } catch (error) {
        reportError(ctx, language.message("preferences_failed") + " " + String(error));
      }
    },
  });
  registerLanguageCommand();
  pi.registerEntryRenderer<{ diff?: unknown }>("tree-versioning.checkpoint", (entry, options, theme) =>
    diffView(entry.data?.diff, language, options, theme));
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(current => {
        const descriptions = ([
          { name: "tree-versioning-language", key: "languageCommand" },
          { name: "tree-versioning-diff", key: "diffCommand" },
        ] as const).map(({ name, key }) => ({ name, key, cached: language.message(key) }));
        return {
          triggerCharacters: current.triggerCharacters,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
            if (!suggestions?.prefix.startsWith("/") || suggestions.prefix.includes(" ")) return suggestions;
            return {
              ...suggestions,
              items: suggestions.items.map(item => {
                const description = descriptions.find(value => value.name === item.value.replace(/:\d+$/, ""));
                return description ? { ...item, description: item.description?.replace(description.cached,
                  language.message(description.key)) } : item;
              }),
            };
          },
          applyCompletion: (...args) => current.applyCompletion(...args),
          shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
        };
      });
    }
    if (preferenceError) notify(ctx, language.message("preferences_failed") + " " + String(preferenceError), "error");
    let restoreFork = false;
    try {
      const initialized = await files.initialize(position(ctx), event.reason);
      const { baseline, created, workspaceRoot } = initialized;
      restoreFork = initialized.restore;
      activeWorkspaceRoot = workspaceRoot;
      if (created) {
        pi.appendEntry("tree-versioning.baseline", baseline);
        notify(ctx, language.message("baselineCreated"), "info");
      }
      notify(ctx, language.message("restorePolicy"), "info");
    } catch (error) {
      const reason = error instanceof VersioningError ? language.message(error.code) : String(error);
      reportError(ctx, event.reason === "fork" ? language.message("inheritanceFailed") + " " + reason : language.message("startupFailed", { reason }));
    }
    if (restoreFork) await restore(position(ctx), ctx);
    // Report optional preference failures only after independent file-history initialization.
    if (preferenceError && !ctx.hasUI) throw new Error(language.message("preferences_failed") + " " + String(preferenceError));
  });
  pi.on("agent_settled", async (_event, ctx) => {
    let recorded: Awaited<ReturnType<SessionFiles["record"]>>;
    try {
      recorded = await files.record(position(ctx));
      const { checkpoint, comparison } = recorded;
      if (!ctx.sessionManager.getBranch().some(entry => entry.id === checkpoint.nodeId)) {
        throw new VersioningError("storage_failed", "Session left the settled node ancestry during checkpoint collection.");
      }
      // One publication keeps the association and its display on the same native branch.
      pi.appendEntry("tree-versioning.checkpoint", { ...checkpoint, diff: comparison });
    } catch (error) {
      const reason = error instanceof VersioningError ? language.message(error.code) : String(error);
      reportError(ctx, language.message("checkpointFailed", { reason }));
      return;
    }
    if (recorded.comparison.status === "error") {
      reportError(ctx, language.message("diffFailed", { reason: language.message(recorded.comparison.code) }));
    }
  });

  const restore = async (destination: SessionPosition, ctx: ExtensionContext) => {
    const generation = ++restoreGeneration;
    try {
      const restored = await files.restore(destination, () => {
        if (!active || generation !== restoreGeneration || !ctx.isIdle()) return false;
        const branch = ctx.sessionManager.getBranch();
        const index = destination.leafId === null ? -1 : branch.findIndex(entry => entry.id === destination.leafId);
        return (destination.leafId === null || index !== -1) &&
          branch.slice(index + 1).every(entry => entry.type === "session_info" || entry.type === "label");
      });
      if (!active) return;
      const key = restored.kind === "baseline" ? "restoredBaseline" :
        restored.nodeId === destination.leafId ? "restoredCheckpoint" : "restoredPredecessor";
      notify(ctx, language.message(key, { id: restored.id, nodeId: restored.kind === "checkpoint" ? restored.nodeId : restored.anchorId ?? "root" }), "info");
    } catch (error) {
      if (!active) return;
      const code = error instanceof VersioningError ? error.code : "restore_failed";
      reportError(ctx, code === "no_baseline" || code === "snapshot_unavailable" || code === "workspace_mismatch"
        ? language.message("restoreUnavailable", { reason: language.message(code) })
        : language.message(code === "restore_superseded" ? code : "restore_failed"));
    }
  };
  pi.on("session_tree", async (event, ctx) => {
    if (event.newLeafId !== event.oldLeafId) await restore({ ...position(ctx), leafId: event.newLeafId }, ctx);
  });

  const queryError = async (error: unknown) => {
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
      diagnostic: diagnostic.content, diagnosticTruncated: diagnostic.truncated, ...diagnosticExport,
    };
    const notice = diagnosticExport && "diagnosticPath" in diagnosticExport
      ? language.message("diagnosticTruncated", { path: diagnosticExport.diagnosticPath })
      : diagnosticExport ? language.message("diagnosticExportFailed") : "";
    const text = language.message(details.code) + "\n" + details.diagnostic + (notice ? "\n" + notice : "");
    return { isError: true, content: [{ type: "text" as const, text }], details, structuredContent: details };
  };

  const queryOutput = async (value: unknown, workspaceRoot: string, filename: string, heading: string) => {
    const fullText = JSON.stringify(value, null, 2);
    const bounded = truncateHead(fullText);
    const fullOutputPath = bounded.truncated ? await exportOutput(fullText, workspaceRoot, filename) : undefined;
    const text = heading + "\n" + bounded.content +
      (fullOutputPath ? "\n" + language.message("outputTruncated", { path: fullOutputPath }) : "");
    return { text, fullOutputPath };
  };

  pi.registerTool({
    name: "session_checkpoints", get label() { return language.message("checkpointsLabel"); },
    description: "Read available file checkpoints and native node associations for this session. Output is limited to 2000 lines / 50 KiB; larger catalogs are exported to a private temporary JSON file.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: checkpointsParameters, outputSchema: checkpointsOutput,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const catalog = await files.checkpoints(position(ctx));
        const { text, fullOutputPath } = await queryOutput(catalog, catalog.workspaceRoot, "checkpoints.json",
          language.message("checkpoints", { count: catalog.checkpoints.length }));
        const { checkpoints: _checkpoints, ...association } = catalog;
        const details = fullOutputPath ? {
          ...association, output: { truncated: true as const, fullOutputPath, totalCheckpoints: catalog.checkpoints.length },
        } : catalog;
        return { content: [{ type: "text" as const, text }], details, structuredContent: details };
      } catch (error) { return queryError(error); }
    },
  });

  pi.registerTool({
    name: "session_diff", get label() { return language.message("diffLabel"); },
    description: "Read round, saved-session, or unsnapshotted workspace differences with explicit endpoints and optional exact file filters. Text is limited to 2000 lines / 50 KiB; larger comparisons are exported to a private temporary JSON file, not a checkpoint.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: diffParameters,
    outputSchema: diffOutput,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const comparison = await files.diff(position(ctx), params);
        const { text, fullOutputPath } = await queryOutput(comparison, comparison.to.workspaceRoot, "comparison.json",
          language.message("comparison", { scope: comparison.scope, count: comparison.files.length }));
        const { files: _fileChanges, ...comparisonEndpoints } = comparison;
        const details = fullOutputPath ? {
          ...comparisonEndpoints, output: { truncated: true as const, fullOutputPath, totalFiles: comparison.files.length },
        } : comparison;
        return { content: [{ type: "text" as const, text }], details, structuredContent: details };
      } catch (error) { return queryError(error); }
    },
  });
}
