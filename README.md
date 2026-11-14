# Pi Tree Versioning

Development build for **@earendil-works/pi-coding-agent 1.5.2**. No public package or release is available. The package name is provisional and publishing is disabled.

## Available now

- Capture a session baseline, including existing uncommitted edits.
- Save a file checkpoint when a complete processing round settles, including interruption and error stops. Parallel tools, steering, queued inputs, automatic retries, and recovery continuations remain part of that round.
- List checkpoints and their native session-node associations with the read-only `session_checkpoints` tool.
- Query round, saved-session, or unsnapshotted workspace differences with the read-only `session_diff` tool.
- Display persistent round-diff cards with file statistics and expandable text, without adding them to model context.
- Open `/tree-versioning-diff` to inspect the current branch\'s saved session diff without changing files or history.
- Restore managed files after successful native `/tree` navigation, using the actual destination's checkpoint, nearest preceding checkpoint, or applicable baseline.
- Preserve file history across reloads, reopening, and session switching. Opening a session never restores or overwrites project files.
- Select English or Simplified Chinese extension messages with `/tree-versioning-language en`, `zh-CN`, or `auto`.

**Not implemented yet:** fork/clone inheritance and fork restoration. Do not use this development build as a backup. Forks/clones with copied baseline metadata currently report unavailable history rather than inventing inherited snapshots.

## Local development

```sh
npm ci
npm run typecheck
npm test
pi -e ./src/index.ts
```

Run the last command from a Git workspace, supplying an absolute extension path when needed. This temporary loading does not add an installation declaration to pi settings.

Verified locally with Node.js 26.5.0, Git 2.50.1, and pi 1.5.2 on macOS. The integration tests use real temporary Git repositories and pi session implementations, including a deterministic agent/tool run; they do not call external models. Tests isolate HOME, pi data, Git configuration, caches, and temporary output. POSIX symbolic links and `mkfifo` are used in safety tests. Other platforms and host versions have not been verified; peer dependency `"*"` ranges are the host's assembly convention, not a compatibility claim.

## Diff cards and viewer

Each newly recorded round stores its semantic comparison in the same context-invisible session entry as the checkpoint association. Cards show the actual baseline/checkpoint IDs, native checkpoint nodes, file list, and text additions/deletions. Binary files show their change status, never a text patch. An unchanged round explicitly shows no file changes.

Use pi's configured **expand tool output** action (default **Ctrl+O**) to expand or collapse card patches. `/tree-versioning-diff` opens a read-only, scrollable overlay for the session baseline → current branch's saved state. It excludes later disk edits and other branches. The viewer uses the configured expand, up/down, page-up/page-down, and cancel actions (defaults **Ctrl+O**, arrows, **Page Up/Page Down**, **Escape**). `/tree-versioning-diff help` explains the comparison. Viewing does not append a session entry, capture files, change the native position, or start a model request.

The viewer needs interactive terminal mode; RPC, print, and JSON modes report that limitation and point to `session_diff` with `scope: "session"`. Automatic cards are still saved in those modes. Queries validate the required snapshots and report missing, corrupt, or uncovered history rather than showing an empty comparison. If recording succeeds but its predecessor cannot be compared, the checkpoint has a durable localized error card, not a false capture-failure or empty-diff message.

Historical cards replay the comparison saved at capture time; they do not revalidate snapshot availability or include subsequent disk changes. Their semantic data survives reloads and reopening and renders in the current language and theme. Older checkpoints recorded before card support have no saved display data; their cards report that limitation, while available snapshots remain queryable. Native branch and compaction visibility rules still apply.

Paths and patches are not translated. Terminal control bytes are visibly escaped so file content cannot execute terminal instructions; ordinary line breaks and tabs in patches are laid out by the host. Text wraps by terminal columns, and expanded content remains reachable by scrolling. Complete comparisons are stored in the session, so large diffs increase session size. Review session exports before sharing: cards can contain source text even though they are excluded from model context.

## Native tree restoration

**Successful `/tree` navigation directly replaces managed files. Unsnapshotted edits are overwritten, and new managed files absent from the target are deleted. There is no merge, extra backup, or confirmation added by this extension.** Startup notifications explain this policy in the selected language. Git HEAD, branch selection, and the index are not changed.

The extension follows the native operation's **actual destination**, not just the selected row. Selecting a user message resumes at its parent; selecting an assistant or tool result continues at that entry; branch summaries follow their parent rather than the abandoned branch. A destination with a checkpoint restores itself. Otherwise, only its ancestors are searched, and the notification names the actual preceding checkpoint and native node. This is not exact per-message or per-tool restoration. When no checkpoint exists, only a baseline that covers the destination can be used.

Cancellation, summary cancellation/failure, and navigation with no actual movement do not restore files. Startup, reload, reopening, and session switching only read history. They never restore files by themselves. The query tools remain read-only; no agent restore tool is registered.

Restoration validates snapshot integrity, identity, paths, current Git exclusions (including filesystem path aliases), and filesystem topology before applying changes. It does not follow directory links or overwrite now-excluded paths. A saved path that now conflicts with ignored content, a submodule, Git administrative data, or an unsafe parent causes an error rather than a forced overwrite. Leaf symbolic links are restored as links; replacing a regular file does not truncate an existing hard-link target.

Missing, corrupt, or uncovered history leaves files alone, reports the problem, and never substitutes a different branch or older snapshot. Other restoration failures report that **files may be partially restored**. The native conversation destination is never undone or redirected, even on error. After fixing a failure, selecting the already-current node is still a no-op; navigate away and back to retry.

Preparation is asynchronous and discarded if newer navigation, agent work, or runtime replacement supersedes it. Harmless session-name or label entries do not invalidate the destination. After preflight, file mutations are synchronous so host operations cannot interleave them; this can pause the UI for large restores. This is **not** a filesystem transaction or protection against external processes concurrently writing or replacing paths. A write failure can leave only some files restored; no global rollback is promised.

## Query contract

`session_diff` accepts:

- `scope`: optional; `"workspace"` (default), `"turn"`, or `"session"`.
- `checkpointId`: optional, for `"turn"` only. Selects a checkpoint returned by `session_checkpoints`, including one on an abandoned branch of this session. Omit it to use the nearest checkpoint on the current ancestry.
- `files`: optional array of exact repository-relative file paths, not globs. A leading `@` is accepted. An empty array selects no files.

| Scope | From | To |
| --- | --- | --- |
| `workspace` | Current ancestry's nearest checkpoint, or an applicable baseline | Current disk workspace |
| `turn` | Selected checkpoint's nearest predecessor on its own ancestry, or an applicable baseline | Selected checkpoint |
| `session` | Applicable session baseline | Current ancestry's nearest saved checkpoint |

Before any checkpoint exists, `session` compares an applicable baseline to itself and returns an empty saved diff; `turn` reports `no_checkpoint`. Saved comparisons never include later disk changes. A missing or damaged nearest snapshot is an error, not permission to substitute an older one.

`session_checkpoints` takes no arguments. It lists checkpoints across the current session, the baseline, and `current: { nodeId, snapshot }`. `snapshot` is the nearest checkpoint on the actual native ancestry, an applicable baseline, or `null` for uncovered history. Native branch-summary entries follow their parent, not the abandoned branch they summarize. Every listed snapshot is validated; an unreadable or corrupt record fails the catalog query rather than silently claiming it is available.

Endpoints identify their kind, session, workspace root, ID, and capture time. Baselines include a coverage `anchorId`; checkpoints include the native `nodeId` at which the round settled, before the extension appends its context-invisible association record. Harmless metadata appends during collection, such as renaming the session, preserve that original association. Workspace endpoints identify the disk working tree. Changed files include status, type/size metadata, and text patches with addition/deletion counts. Binary files have summaries, not text patches. Symbolic links describe the link target without reading it; `targetEncoding` is `utf8` for text targets or `base64` for non-UTF-8 target bytes. Paths and patches are never translated.

The declared output schema and `structuredContent` expose the same semantic data as `details` to programmatic callers, independent of UI language. Success has `status: "ok"`; failures have `status: "error"` and a stable English `code`, and are marked as tool errors. Error diagnostics are bounded; when truncated, `diagnosticPath` points to the full private temporary text export. If safe export fails, `diagnosticExportFailed` is set and the original error is retained. Missing, corrupt, or inapplicable history is an error, not an empty diff; Git HEAD and other branches' newer snapshots are never used as substitutes. Unsupported comparison scopes do not return placeholder results.

Model-facing output is bounded to approximately 50 KiB / 2000 lines plus a short notice. Larger results are exported to a private temporary JSON file outside the workspace. In that case, `details.output` contains `truncated`, `fullOutputPath`, and `totalFiles` or `totalCheckpoints`; the corresponding `files` or `checkpoints` array is omitted, **not an empty result**. Read the exported JSON for the complete result. These exports are not checkpoints; queries do not change the workspace, Git state, session position, file history, or language preferences. Tool results enter model context normally. Automatic baseline/checkpoint association records do not; a round containing only queries still gets its ordinary checkpoint when processing stops.

## Managed files and storage

The scope is the **whole Git working tree**, even when pi starts in a subdirectory: tracked files (including tracked ignored paths) and non-ignored untracked files. Deletions, binary bytes, executable flags, and symbolic links are preserved. Untracked ignored files, Git administrative data, submodule contents, and paths outside the working tree are excluded. Directory links are not traversed.

Baselines and checkpoints are stored independently of project Git under `~/.pi/agent/tree-versioning/<session-id>/`, respecting `PI_CODING_AGENT_DIR`. Snapshot checksums and session/workspace identities are validated before comparison or restoration. Failed collection does not publish a partial baseline or checkpoint. Failures use localized UI notifications, or the host extension-error channel in print/JSON modes, without adding a model message. A successfully captured unchanged round has a checkpoint and an empty round diff, unlike a failed capture. A first activation in an old session covers only the activation position and new descendants, not earlier history or descendants that already existed before activation.

Collection reads files as they are encountered; it is not an atomic filesystem snapshot during concurrent writes. Snapshots are currently kept in full, with no automatic cleanup or remote synchronization. Large repositories can require substantial memory and disk space. Both the pi data directory and the current session file must be outside the managed workspace. Baseline and checkpoint creation reject contained persistence before writing snapshots or session metadata, avoiding self-referential changes.

## Language

Use `/tree-versioning-language help` for usage and the current preference. Selection is saved only in the extension's `tree-versioning/preferences.json`, not pi's `settings.json`, and is shared across sessions and restarts.

`auto` checks `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the runtime system locale. Simplified Chinese (`zh`, `zh-CN`, `zh-SG`, `zh-Hans` variants) uses `zh-CN`; English, unknown, and unsupported locales use English. Explicit `en` or `zh-CN` overrides the system locale. Tool names, parameters, status codes, and result semantics do not change with UI language.

Formal installation artifacts, bilingual release documentation, and the MIT copyright notice will be completed before publication; this is not a release-ready package.
