import assert from "node:assert/strict";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ExtensionUIContext, type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export async function fixture() {
  const root = await realpath(await mkdtemp(join(process.env.HOME!, "workspace-")));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Integration Test");
  await writeFile(join(cwd, "notes.txt"), "committed\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "Initial test state");
  return { root, cwd, agentDir };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

interface LoadOptions {
  autocomplete?: AutocompleteProvider;
  extensionFactories?: ExtensionFactory[];
  sessionStartEvent?: SessionStartEvent;
  mode?: "tui" | "rpc" | "json" | "print";
  expectedStartupErrors?: number;
  custom?: ExtensionUIContext["custom"];
}

export async function load(testWorkspace: Fixture, manager = SessionManager.create(testWorkspace.cwd, join(testWorkspace.root, "sessions")), options: LoadOptions = {}) {
  let { autocomplete } = options;
  const { extensionFactories = [], sessionStartEvent } = options;
  process.env.PI_CODING_AGENT_DIR = testWorkspace.agentDir;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: testWorkspace.cwd, agentDir: testWorkspace.agentDir, settingsManager,
    additionalExtensionPaths: [resolve("src/index.ts")], extensionFactories,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(testWorkspace.agentDir, "auth.json"), modelsPath: join(testWorkspace.agentDir, "models.json"),
    modelsStorePath: join(testWorkspace.agentDir, "model-cache.json"), refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: testWorkspace.cwd, agentDir: testWorkspace.agentDir, sessionManager: manager,
    settingsManager, modelRuntime, resourceLoader, sessionStartEvent,
  });
  // Fail closed if any test accidentally tries to use a real model.
  session.agent.streamFunction = () => { throw new Error("Unexpected model request"); };
  const notices: { message: string; type?: string }[] = [];
  const errors: string[] = [];
  const ui = {
    ...session.extensionRunner.getUIContext(),
    notify(message: string, type?: string) { notices.push({ message, type }); },
    ...(options.custom ? { custom: options.custom } : {}),
    addAutocompleteProvider(factory) { if (autocomplete) autocomplete = factory(autocomplete); },
  } satisfies ExtensionUIContext;
  const startupLeaf = manager.getLeafId();
  const mode = options.mode ?? (autocomplete ? "tui" : "rpc");
  await session.bindExtensions({ uiContext: mode === "print" || mode === "json" ? undefined : ui, mode, onError: error => errors.push(error.error) });
  assert.equal(errors.length, options.expectedStartupErrors ?? 0, errors.join("\n"));
  return {
    session, manager, notices, errors, startupLeaf, modelRuntime,
    get autocomplete() { return autocomplete; },
    async diff(args: Record<string, unknown> = {}) { return this.query("session_diff", args); },
    async checkpoints() { return this.query("session_checkpoints"); },
    async query(name: string, args: Record<string, unknown> = {}) {
      const tool = session.extensionRunner.getToolDefinition(name);
      assert.ok(tool, `The loaded extension must register ${name}`);
      const context = session.extensionRunner.createToolContext("test-query", undefined);
      const result = await tool.execute("test-query", args, undefined, undefined, context);
      return { ...result, isError: result.isError ?? false };
    },
    async command(args: string) { await session.prompt("/tree-versioning-language " + args); },
  };
}

export function dispose(...sessions: AgentSession[]) {
  for (const session of sessions) session.dispose();
}
