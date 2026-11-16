# Pi Tree Versioning

[简体中文](README.zh-CN.md)

Keep file history alongside pi's native session tree: save checkpoints after each processing round, inspect changes, and restore saved files when navigating or forking. The interface supports English and Simplified Chinese.

**With file restoration enabled (the default), `/tree` or `/fork` can overwrite unsnapshotted edits.** Read the [restoration rules](#restoring-files) before using these commands.

## Install

Verified host: **@earendil-works/pi-coding-agent 1.5.2**. Have Git, Node.js, and the npm command-line client available.

```sh
pi install git:github.com/nosweet789/pi-tree-versioning
```

Pi downloads the extension and installs its dependencies. Start pi in the Git project you want to work on, or use `/reload` in an existing session.

To try it for one invocation:

```sh
pi -e git:github.com/nosweet789/pi-tree-versioning
```

Temporary loading leaves package declarations unchanged. Downloaded files are cached, and session history, snapshots, and saved language and restoration preferences use their normal storage.

`pi install` adds the package to your user settings. Add `--local` to use the project's `.pi/settings.json`; project resources load after you grant trust. Other existing settings are preserved.

### Update or remove

```sh
pi update git:github.com/nosweet789/pi-tree-versioning
pi remove git:github.com/nosweet789/pi-tree-versioning
```

Use the same scope as installation, adding `--local` for a project install. Plain `pi update` updates pi itself. To pin an extension version, append `@<tag-or-commit>` to its Git source, using an existing tag or commit. Removing the extension leaves saved snapshots on disk.

### Load a local checkout

Run `npm ci` in the checkout, then load it from your working project:

```sh
pi -e /absolute/path/to/pi-tree-versioning
```

For a persistent local installation, use `pi install /absolute/path/to/pi-tree-versioning`. Keep that checkout and its dependencies available: pi loads local paths in place.

## View changes

On activation, the extension captures a **session baseline**, including existing uncommitted edits. Each complete processing round saves a checkpoint when pi settles and waits for input, including interruption and error stops. Steering, queued input, and automatic retries stay within the continuous round.

Each checkpoint adds a card with changed files and addition/deletion counts. Use pi's **expand tool output** action, **Ctrl+O** by default, to inspect text patches. Binary files show change summaries. An unchanged round still gets a checkpoint and an empty-diff card.

To view the current branch's saved total diff:

```text
/tree-versioning-diff
```

The read-only viewer compares the session baseline with the current branch's saved checkpoint. Later disk edits belong to the workspace comparison described below.

Default viewer keys are **Ctrl+O** to expand patches, **↑/↓** to scroll, **Page Up/Page Down** to move by page, and **Escape** to close. Your pi keybindings apply. Use `/tree-versioning-diff help` for help; in RPC, print, or JSON mode, query `session_diff` with `scope: "session"`.

Cards display the comparison saved at capture time and render in the current language and theme after reopening. They are for display only; agent queries through the tools below enter model context normally. Paths and code retain their original text, with terminal control bytes shown as visible escapes. Review session exports before sharing, because cards can contain source text.

## Restoring files

Automatic file restoration is **on by default**. Use these commands to check or change it:

```text
/tree-versioning-restore
/tree-versioning-restore off
/tree-versioning-restore on
```

No argument, or `help`, shows the current state and usage. The choice is saved globally in the extension's `tree-versioning/preferences.json`, under the pi data directory. It applies across workspaces, new sessions, session switches, reloads, and restarts; a new session does **not** reset it to on. Other already-running pi instances pick up the saved choice when their extension runtime reloads, for example with `/reload`.

With restoration **off**, `/tree` and `/fork` keep current disk files. Baseline and checkpoint capture, diff cards and queries, and fork/clone snapshot inheritance continue normally. A subsequent round records the actual disk state, even if it differs from the conversation's historical position.

Turning restoration off invalidates pending restores that have not started writing; turning it back on cannot revive them. Turning it on does **not** restore the current position immediately or replay earlier navigation. Only subsequent navigation or forks can restore files. Switching does not interrupt a synchronous write already in progress.

**Restoration directly applies the target snapshot. It overwrites unsnapshotted managed-file edits and deletes new managed files absent from the target. There is no merge, extra backup, or added confirmation. Back up important edits before navigating.**

| Operation | File behavior with restoration on |
| --- | --- |
| Successful `/tree` navigation | Restore the actual destination's saved state |
| Successful `/fork` in the same workspace | Inherit history, then restore the fork destination |
| `/clone` in the same workspace | Inherit history and keep current disk edits |
| Startup, reload, reopening, or session switching | Read history or establish a baseline; keep current files |
| Cancelled/failed navigation or fork, or selecting the current destination | Keep current files |

Checkpoints represent **complete processing rounds**, rather than every message or tool step. At a destination without its own checkpoint, restoration follows that destination's ancestors to the nearest preceding checkpoint, or an applicable baseline. The notification names the state actually restored. Pi's native destination is authoritative: selecting a user message resumes at its parent.

A fork or clone inherits the source baseline and only the copied path's checkpoints. Saved-session comparisons continue from that inherited baseline. Once inheritance completes, the child owns its snapshots independently, so clearing the source history later leaves the child's history usable. This inheritance applies within the same Git working tree.

### When an operation fails

- **Preference failures:** if loading or reading preferences before a save fails, the extension reports the error and disables restoration for that runtime; file-history initialization and collection remain independent. Damaged preferences are left untouched: correct the file, then reload or retry the command. If only writing fails, the previous choice remains and no successful save is reported.
- **Capture failure:** the extension reports that the round was not recorded. If only the diff comparison fails, the checkpoint remains recorded and its card reports the comparison error.
- **Missing, damaged, or uncovered history:** files stay in place and the extension reports the unavailable history. Queries report an error rather than an empty diff or a substitute from another branch.
- **Restore failure:** the native conversation destination remains selected, and **files may be partially restored**. If a fork already succeeded, the child session remains. Inspect the files, resolve the error, then navigate away and back to retry.

On first activation in an existing session, the baseline covers the activation position and new descendants. Earlier nodes and descendants already present at activation remain uncovered. Opening or reloading a session does not retry a failed restoration.

## Agent tools

Ask the agent to inspect restoration status and file history using these read-only tools:

- `tree_versioning_status`: no parameters; returns the current runtime's effective `{ "restoreEnabled": true }` or `{ "restoreEnabled": false }`. It does not scan files, restore them, or change preferences. Use the user command above to change the switch.
- `session_checkpoints`: list the session's baseline, checkpoints, native node associations, and the current position's applicable snapshot.
- `session_diff`: compare saved states or the current workspace, with explicit endpoints.

| `scope` | From | To |
| --- | --- | --- |
| `workspace` (default) | Current path's nearest checkpoint, or applicable baseline | Current disk files |
| `turn` | Selected checkpoint's preceding checkpoint, or applicable baseline | Selected checkpoint |
| `session` | Session baseline | Current path's saved checkpoint |

For `turn`, optional `checkpointId` selects an ID from `session_checkpoints`; omitting it uses the current path's nearest checkpoint. Optional `files` filters by exact repository-relative paths, with an optional leading `@`. These are exact paths, not globs; an empty array selects no files.

Before the first checkpoint, `session` compares the baseline to itself and `turn` reports `no_checkpoint`. A missing or damaged required snapshot is an error. Queries leave workspace files, the native tree position, and checkpoints unchanged; the normal end-of-round capture still runs after an agent round containing only queries.

Tool output is limited to approximately **50 KiB / 2000 lines**. Larger results provide `output.fullOutputPath`, a private temporary JSON file containing the full result. In that case, an omitted `files` or `checkpoints` array means the result was exported, not that it was empty.

## File scope and storage

The extension manages the **whole Git working tree**, including when pi starts in a subdirectory:

- Tracked files, including tracked paths that match ignore rules.
- Non-ignored untracked files.
- File additions, deletions, binary contents, executable flags, and symbolic links.

Untracked ignored files, Git administrative data, submodule contents, and paths outside the working tree are excluded. Symbolic links are stored as links rather than followed. The extension preserves Git HEAD, branch selection, and the index.

Snapshots live under `~/.pi/agent/tree-versioning/<session-id>/`, following `PI_CODING_AGENT_DIR` when set. Keep the pi data directory and session files outside the managed working tree. Persistent sessions retain their file history across restarts; `--no-session` conversations end with the process.

Snapshots are stored in full on the local machine and are cleaned up manually. Cross-machine synchronization is outside the supported scope. Large worktrees can use substantial memory and disk space, and long restores can pause the UI. Concurrent file writes and multi-file restoration have no cross-file atomicity guarantee.

## Language

Choose the extension's interface language:

```text
/tree-versioning-language en
/tree-versioning-language zh-CN
/tree-versioning-language auto
```

Use `/tree-versioning-language help` to see the current preference. The selection is saved in the extension's `tree-versioning/preferences.json` and carries across sessions and restarts. Existing cards render in the selected language; checkpoints and comparison results remain the same.

`auto` checks `LC_ALL`, `LC_MESSAGES`, `LANG`, then the system locale. Simplified Chinese locales (`zh`, `zh-CN`, `zh-SG`, and `zh-Hans` variants) select `zh-CN`; other locales use English. Explicit `en` or `zh-CN` takes precedence.

Language selection applies to this extension's UI. Pi's native UI follows its own settings; tool names, parameters, status codes, file paths, and code retain their original form.

## Development

```sh
npm ci
npm run build
npm test
npm run test:package
```

The extension loads TypeScript directly; `build` runs typechecking. Tests use isolated Git worktrees and deterministic model fixtures. The verified development environment is macOS with Node.js 26.5.0 and Git 2.50.1; safety tests use POSIX symbolic links and `mkfifo`.

## License

[MIT](LICENSE). Copyright (c) 2026 nosweet789.
