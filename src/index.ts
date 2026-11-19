import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { checkpointsOutput, checkpointsParameters, diffOutput, diffParameters, statusOutput, statusParameters } from "./tool-contract.ts";
export type { CheckpointsInput, DiffInput, StatusInput } from "./tool-contract.ts";
import { checkpointEntryType, SessionFiles, type CheckpointEntryData, type SessionPosition } from "./session-files.ts";
import { VersioningError } from "./errors.ts";
import { isLanguagePreference, Language } from "./language.ts";
import { Preferences } from "./preferences.ts";
import { exportOutput } from "./tool-output.ts";
import { diffCommandName, diffView, roundDiffArgument, setRoundDiffPreview, showDiff, terminalText } from "./diff-view.ts";
import { findWorkspaceRoot, isSearchDepth, workspaceRoot, type repositoryCoverage } from "./repositories.ts";

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
  let skippedSessionId: string | undefined;
  const isFileVersioningSkipped = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId() === skippedSessionId;
  let activeWorkspace: { root: string; coverage: ReturnType<typeof repositoryCoverage> } | undefined;
  let restoreGeneration = 0;
  let active = true;
  pi.on("session_before_fork", async (event, ctx) => {
    try { await files.prepareFork(position(ctx), event.entryId, event.position); }
    catch { reportError(ctx, language.message("inheritanceFailed")); }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    active = false;
    restoreGeneration++;
    await preferences.waitForSaves();
    try { await files.shutdown(position(ctx), event); }
    catch { reportError(ctx, language.message("inheritanceFailed")); }
  });
  pi.on("before_agent_start", () => { restoreGeneration++; });
  const preferences = new Preferences(join(storage, "preferences.json"));
  const language = new Language(() => preferences.language);
  let preferenceError: unknown;
  try { await preferences.load(); } catch (error) { preferenceError = error; }
  let pendingRestoreChanges = 0;
  const restorationEnabled = () => preferences.restoreEnabled && pendingRestoreChanges === 0;
  let previewGeneration = 0;
  const isCurrentLeaf = (ctx: ExtensionContext, leafId: string | null) =>
    active && ctx.sessionManager.getLeafId() === leafId;
  const refreshRoundPreview = async (ctx: ExtensionContext, leafId = ctx.sessionManager.getLeafId()) => {
    if (ctx.mode !== "tui" || !isCurrentLeaf(ctx, leafId)) return;
    const generation = ++previewGeneration;
    const preview = await files.roundDiffPreview(position(ctx));
    if (isCurrentLeaf(ctx, leafId) && generation === previewGeneration) setRoundDiffPreview(ctx, language, preview);
  };

  const diffCommandUsage = { command: `/${diffCommandName}`, round: roundDiffArgument };
  const registerDiffCommand = () => pi.registerCommand(diffCommandName, {
    description: language.message("diffCommand"),
    handler: async (args, ctx) => {
      const argument = args.trim();
      const round = argument === roundDiffArgument;
      if (argument && !round) {
        notify(ctx, language.message("diffHelp", diffCommandUsage), "info");
        return;
      }
      if (isFileVersioningSkipped(ctx)) {
        let root: string | undefined;
        try { root = await findWorkspaceRoot(ctx.cwd); }
        catch (error) {
          reportError(ctx, language.message("query_failed") + " " + String(error));
          return;
        }
        const message = language.message(root === undefined ? "diffOutsideGit" : "diffSkippedAtStartup");
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        // An informational notice is not model output or a JSON event.
        else await new Promise<void>((resolve, reject) => {
          process.stderr.write(message + "\n", error => error ? reject(error) : resolve());
        });
        return;
      }
      if (ctx.mode !== "tui") {
        reportError(ctx, language.message("viewerRequiresTui"));
        return;
      }
      try {
        const selected = position(ctx);
        const preview = round ? await files.roundDiffPreview(selected) : undefined;
        if (round && !preview) {
          notify(ctx, language.message("roundDiffNoPreview", diffCommandUsage), "info");
          return;
        }
        const comparison = preview ? preview.diff : await files.diff(selected, { scope: "session" });
        if (!isCurrentLeaf(ctx, selected.leafId)) return;
        previewGeneration++;
        setRoundDiffPreview(ctx, language);
        try { await showDiff(comparison, language, ctx); }
        finally { await refreshRoundPreview(ctx, selected.leafId); }
      } catch (error) {
        const reason = error instanceof VersioningError ? language.message(error.code) : language.message("query_failed") + " " + String(error);
        notify(ctx, reason, "error");
      }
    },
  });
  registerDiffCommand();
  const registerRestoreCommand = () => pi.registerCommand("tree-versioning-restore", {
    description: language.message("restoreCommand"),
    getArgumentCompletions: prefix => ["on", "off"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (choice !== "on" && choice !== "off") {
        notify(ctx, language.message("restoreHelp", { state: language.message(restorationEnabled() ? "restoreOn" : "restoreOff") }), "info");
        return;
      }
      restoreGeneration++;
      pendingRestoreChanges++;
      try {
        await preferences.save({ restoreEnabled: choice === "on" });
        notify(ctx, language.message("restoreSaved", { state: language.message(preferences.restoreEnabled ? "restoreOn" : "restoreOff") }) + " " +
          language.message(preferences.restoreEnabled ? "restorePolicy" : "restoreDisabled"), "info");
      } catch (error) {
        reportError(ctx, language.message("preferences_failed") + " " + String(error));
      } finally { pendingRestoreChanges--; }
    },
  });
  registerRestoreCommand();
  const registerDepthCommand = () => pi.registerCommand("tree-versioning-repository-depth", {
    description: language.message("repositoryDepthCommand"),
    handler: async (args, ctx) => {
      const choice = args.trim();
      try {
        const root = activeWorkspace?.root ?? await workspaceRoot(ctx.cwd);
        if (choice && /^(0|[1-9][0-9]*)$/.test(choice) && isSearchDepth(Number(choice))) {
          await preferences.saveRepositoryDepth(root, Number(choice));
          notify(ctx, language.message("repositoryDepthSaved", { depth: Number(choice) }), "info");
          return;
        }
        const coverage = activeWorkspace?.coverage;
        notify(ctx, language.message("repositoryDepthHelp", { depth: preferences.repositoryDepth(root) }) + "\n" +
          (coverage ? language.message("repositoryCoverage", { depth: coverage.searchDepth,
            repositories: terminalText(JSON.stringify(coverage.repositories)) }) : language.message("repositoryCoverageUnavailable")), "info");
      } catch (error) { reportError(ctx, language.message("preferences_failed") + " " + String(error)); }
    },
  });
  registerDepthCommand();
  const registerLanguageCommand = () => pi.registerCommand("tree-versioning-language", {
    description: language.message("languageCommand"),
    getArgumentCompletions: prefix => ["en", "zh-CN", "auto"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (!isLanguagePreference(choice)) {
        notify(ctx, language.message("languageHelp", { preference: preferences.language }), "info");
        return;
      }
      try {
        await preferences.save({ language: choice });
        registerLanguageCommand();
        registerDiffCommand();
        registerRestoreCommand();
        registerDepthCommand();
        notify(ctx, language.message("languageSaved", { preference: choice }), "info");
      } catch (error) {
        reportError(ctx, language.message("preferences_failed") + " " + String(error));
      }
    },
  });
  registerLanguageCommand();
  pi.registerEntryRenderer<CheckpointEntryData>(checkpointEntryType, (entry, options, theme) =>
    diffView(entry.data?.diff, language, options, theme));
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(current => {
        const descriptions = ([
          { name: "tree-versioning-language", key: "languageCommand" },
          { name: diffCommandName, key: "diffCommand" },
          { name: "tree-versioning-restore", key: "restoreCommand" },
          { name: "tree-versioning-repository-depth", key: "repositoryDepthCommand" },
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
      const session = position(ctx);
      skippedSessionId = undefined;
      activeWorkspace = undefined;
      const initialized = await files.initialize(session, event, root => preferences.repositoryDepth(root));
      if (!initialized) {
        skippedSessionId = session.sessionId;
      } else {
        const { baseline, created, workspaceRoot: root, coverage } = initialized;
        restoreFork = initialized.restore;
        activeWorkspace = { root, coverage };
        if (created) {
          pi.appendEntry("tree-versioning.baseline", baseline);
          notify(ctx, language.message("baselineCreated"), "info");
        }
        if (coverage.searchDepth > 0) {
          notify(ctx, language.message("repositoryCoverage", { depth: coverage.searchDepth,
            repositories: terminalText(JSON.stringify(coverage.repositories)) }), "info");
        }
        notify(ctx, language.message(preferences.restoreEnabled ? "restorePolicy" : "restoreDisabled"), "info");
      }
    } catch (error) {
      const reason = error instanceof VersioningError ? language.message(error.code) : String(error);
      reportError(ctx, event.reason === "fork" ? language.message("inheritanceFailed") + " " + reason : language.message("startupFailed", { reason }));
    }
    if (restoreFork) await restore(position(ctx), ctx);
    await refreshRoundPreview(ctx);
    // Report optional preference failures only after independent file-history initialization.
    if (preferenceError && !ctx.hasUI) throw new Error(language.message("preferences_failed") + " " + String(preferenceError));
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (isFileVersioningSkipped(ctx)) return;
    let recorded: Awaited<ReturnType<SessionFiles["record"]>>;
    try {
      recorded = await files.record(position(ctx));
      const { checkpoint, comparison } = recorded;
      if (!ctx.sessionManager.getBranch().some(entry => entry.id === checkpoint.nodeId)) {
        throw new VersioningError("storage_failed", "Session left the settled node ancestry during checkpoint collection.");
      }
      // One publication keeps the association and its display on the same native branch.
      pi.appendEntry(checkpointEntryType, { ...checkpoint, diff: comparison });
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
    if (isFileVersioningSkipped(ctx) || !restorationEnabled()) return;
    const generation = ++restoreGeneration;
    try {
      const restored = await files.restore(destination, () => {
        if (!active || !restorationEnabled() || generation !== restoreGeneration || !ctx.isIdle()) return false;
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
  pi.on("session_tree", async (event, ctx) => {
    // Never append a card to the native branch just to display an existing one.
    if (event.newLeafId !== event.oldLeafId) await refreshRoundPreview(ctx, event.newLeafId);
  });

  const queryError = async (error: unknown) => {
    const rawDiagnostic = error instanceof Error ? error.message : String(error);
    const diagnostic = truncateHead(rawDiagnostic, { maxBytes: 32 * 1024, maxLines: 1500 });
    let diagnosticExport: { diagnosticPath: string } | { diagnosticExportFailed: true } | undefined;
    if (diagnostic.truncated) {
      try { diagnosticExport = { diagnosticPath: await exportOutput(rawDiagnostic, activeWorkspace?.root, "diagnostic.txt") }; }
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
    name: "tree_versioning_status", get label() { return language.message("statusLabel"); },
    description: "Read whether automatic file restoration is currently enabled in this runtime. Returns restoreEnabled; does not scan the workspace or change files, preferences, or history. The switch controls native /tree and /fork restoration, not checkpoint collection or diff queries.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: statusParameters, outputSchema: statusOutput,
    async execute() {
      const details = { restoreEnabled: restorationEnabled() };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, structuredContent: details };
    },
  });

  pi.registerTool({
    name: "session_checkpoints", get label() { return language.message("checkpointsLabel"); },
    description: "Read available file checkpoints, native node associations, and frozen repository coverage for this session. Output is limited to 2000 lines / 50 KiB; larger catalogs are exported to a private temporary JSON file.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: checkpointsParameters, outputSchema: checkpointsOutput,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const catalog = await files.checkpoints(position(ctx));
        const { text, fullOutputPath } = await queryOutput(catalog, catalog.workspaceRoot, "checkpoints.json",
          language.message("checkpoints", { count: catalog.checkpoints.length }));
        const { checkpoints: _checkpoints, coverage: _coverage, ...association } = catalog;
        const details = fullOutputPath ? {
          ...association, output: { truncated: true as const, fullOutputPath, totalCheckpoints: catalog.checkpoints.length,
            totalRepositories: catalog.coverage.repositories.length },
        } : catalog;
        return { content: [{ type: "text" as const, text }], details, structuredContent: details };
      } catch (error) { return queryError(error); }
    },
  });

  pi.registerTool({
    name: "session_diff", get label() { return language.message("diffLabel"); },
    description: "Read round, saved-session, or unsnapshotted workspace differences with explicit endpoints, frozen repository coverage, and optional exact outer-workspace-relative file filters. Text is limited to 2000 lines / 50 KiB; larger comparisons are exported to a private temporary JSON file, not a checkpoint.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: diffParameters,
    outputSchema: diffOutput,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const comparison = await files.diff(position(ctx), params);
        const { text, fullOutputPath } = await queryOutput(comparison, comparison.to.workspaceRoot, "comparison.json",
          language.message("comparison", { scope: comparison.scope, count: comparison.files.length }));
        const { files: _fileChanges, coverage: _coverage, ...comparisonEndpoints } = comparison;
        const details = fullOutputPath ? {
          ...comparisonEndpoints, output: { truncated: true as const, fullOutputPath, totalFiles: comparison.files.length,
            totalRepositories: comparison.coverage.repositories.length },
        } : comparison;
        return { content: [{ type: "text" as const, text }], details, structuredContent: details };
      } catch (error) { return queryError(error); }
    },
  });
}
