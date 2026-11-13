# Pi Tree Versioning

Development build for **@earendil-works/pi-coding-agent 1.5.2**. No public package or release is available. The package name is provisional and publishing is disabled.

## Available now

- Capture a session baseline, including existing uncommitted edits.
- Query net changes from that baseline to the current disk workspace with the read-only `session_diff` tool.
- Preserve the baseline across reloads and reopening. Opening a session never restores or overwrites project files.
- Select English or Simplified Chinese extension messages with `/tree-versioning-language en`, `zh-CN`, or `auto`.

**Not implemented yet:** processing-round checkpoints, turn/session-total comparisons, diff cards, file restoration, and fork/clone inheritance. Do not use this development slice as a backup or assume that tree navigation restores files. Forks/clones with copied baseline metadata currently report unavailable history rather than inventing inherited snapshots.

## Local development

```sh
npm ci
npm run typecheck
npm test
pi -e ./src/index.ts
```

Run the last command from a Git workspace, supplying an absolute extension path when needed. This temporary loading does not add an installation declaration to pi settings.

Verified locally with Node.js 26.5.0, Git 2.50.1, and pi 1.5.2 on macOS. The integration tests use real temporary Git repositories and pi session implementations, including a deterministic agent/tool run; they do not call external models. Tests isolate HOME, pi data, Git configuration, caches, and temporary output. POSIX symbolic links and `mkfifo` are used in safety tests. Other platforms and host versions have not been verified; peer dependency `"*"` ranges are the host's assembly convention, not a compatibility claim.

## Query contract

`session_diff` accepts:

- `scope`: optional; only `"workspace"` is implemented.
- `files`: optional array of exact repository-relative file paths, not globs. A leading `@` is accepted. An empty array selects no files.

The result identifies the baseline (session, workspace root, ID, capture time, and coverage anchor) and disk-workspace endpoint. Changed files include status, type/size metadata, and text patches with addition/deletion counts. Binary files have summaries, not text patches. Symbolic links describe the link target without reading it; `targetEncoding` is `utf8` for text targets or `base64` for non-UTF-8 target bytes. Paths and patches are never translated.

The declared output schema and `structuredContent` expose the same semantic data as `details` to programmatic callers, independent of UI language. Success has `status: "ok"`; failures have `status: "error"` and a stable English `code`, and are marked as tool errors. Error diagnostics are bounded; when truncated, `diagnosticPath` points to the full private temporary text export. If safe export fails, `diagnosticExportFailed` is set and the original error is retained. Missing, corrupt, or inapplicable baselines are errors, not empty diffs; Git HEAD is never used as a substitute. Unsupported comparison scopes do not return placeholder results.

Model-facing output is bounded to approximately 50 KiB / 2000 lines plus a short notice. Larger comparisons are exported to a private temporary JSON file outside the workspace. In that case, `details.output` contains `truncated`, `totalFiles`, and `fullOutputPath`; `details.files` is omitted, **not an empty comparison**. Read the exported JSON for the complete result. These exports are not checkpoints; queries do not change the workspace, Git state, session position, baseline, or language preferences.

## Managed files and storage

The scope is the **whole Git working tree**, even when pi starts in a subdirectory: tracked files (including tracked ignored paths) and non-ignored untracked files. Deletions, binary bytes, executable flags, and symbolic links are preserved. Untracked ignored files, Git administrative data, submodule contents, and paths outside the working tree are excluded. Directory links are not traversed.

Baselines are stored independently of project Git under `~/.pi/agent/tree-versioning/<session-id>/`, respecting `PI_CODING_AGENT_DIR`. Snapshot checksums and session/workspace identities are validated before comparison. Failed collection does not publish a partial baseline. A first activation in an old session covers only the activation position and new descendants, not earlier history or descendants that already existed before activation.

Collection reads files as they are encountered; it is not an atomic filesystem snapshot during concurrent writes. Snapshots are currently kept in full, with no automatic cleanup or remote synchronization. Large repositories can require substantial memory and disk space. Both the pi data directory and the current session file must be outside the managed workspace. Baseline creation rejects contained persistence before writing snapshots or session metadata, avoiding self-referential changes.

## Language

Use `/tree-versioning-language help` for usage and the current preference. Selection is saved only in the extension's `tree-versioning/preferences.json`, not pi's `settings.json`, and is shared across sessions and restarts.

`auto` checks `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the runtime system locale. Simplified Chinese (`zh`, `zh-CN`, `zh-SG`, `zh-Hans` variants) uses `zh-CN`; English, unknown, and unsupported locales use English. Explicit `en` or `zh-CN` overrides the system locale. Tool names, parameters, status codes, and result semantics do not change with UI language.

Formal installation artifacts, bilingual release documentation, and the MIT copyright notice will be completed before publication; this is not a release-ready package.
