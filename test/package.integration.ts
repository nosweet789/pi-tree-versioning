import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fixture, type Fixture } from "./harness.ts";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.HOME!;
const environment: Record<string, string> = {};
for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "LC_ALL",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"]) {
  if (process.env[key] !== undefined) environment[key] = process.env[key]!;
}
Object.assign(environment, {
  npm_config_cache: join(home, "npm-cache"),
  npm_config_userconfig: join(home, "npmrc"),
  npm_config_globalconfig: join(home, "global-npmrc"),
  npm_config_prefix: join(home, "npm-prefix"),
  npm_config_update_notifier: "false",
});

async function run(command: string, args: string[], cwd = sourceRoot, env = environment) {
  return execute(command, args, { cwd, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const initialSettings = { theme: "light", steeringMode: "one-at-a-time", retry: { enabled: false } };

function clientFor(workspace: Fixture, args: string[] = []) {
  // RpcClient merges its environment; explicitly mask inherited credentials and host overrides.
  const masked = Object.fromEntries(Object.keys(process.env).map(key => [key, ""]));
  return new RpcClient({
    cliPath, cwd: workspace.cwd,
    env: { ...masked, ...environment, PI_CODING_AGENT_DIR: workspace.agentDir },
    args: ["--offline", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-approve", ...args],
  });
}

async function inspectLoaded(workspace: Fixture, args: string[] = [], language = "en") {
  const client = clientFor(workspace, args);
  try {
    await client.start();
    const commands = await client.getCommands();
    const command = commands.find(value => value.name === "tree-versioning-diff");
    assert.ok(command, "The installed package must register its diff command");
    assert.match(command.description!, language === "en" ? /saved session diff/ : /会话总差异/);
    const restoreCommand = commands.find(value => value.name === "tree-versioning-restore");
    assert.ok(restoreCommand, "The installed package must register its restoration command");
    assert.match(restoreCommand.description!, language === "en" ? /restore the current position with here/ : /here 恢复当前落点/);
    const depthCommand = commands.find(value => value.name === "tree-versioning-repository-depth");
    assert.ok(depthCommand, "The installed package must register its repository depth command");
    assert.match(depthCommand.description!, language === "en" ? /repository search depth/ : /仓库搜索深度/);
    const before = await client.getEntries();
    assert.ok(before.entries.some(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline"));
    assert.equal(await client.prompt("/tree-versioning-repository-depth 1"), "handled");
    assert.equal(await client.prompt("/tree-versioning-restore off"), "handled");
    assert.equal(await client.prompt("/tree-versioning-language zh-CN"), "handled");
    const localized = (await client.getCommands()).find(value => value.name === "tree-versioning-diff")!;
    assert.match(localized.description!, /会话总差异/);
    assert.deepEqual(await client.getEntries(), before, "Preference commands must not append history or start a model");
    return dirname(dirname(command.sourceInfo.path));
  } finally { await client.stop(); }
}

test("the local archive includes its explicit entry, both languages, license, and only distribution files", async context => {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-tree-versioning");
  assert.equal(manifest.private, true, "Git distribution must not enable npm publishing");
  assert.deepEqual(manifest.repository, { type: "git", url: "git+https://github.com/nosweet789/pi-tree-versioning.git" });
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.license, "MIT");
  for (const path of ["src", "README.md", "README.zh-CN.md", "LICENSE"]) assert.ok(manifest.files.includes(path), path);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies[name], undefined);
  }
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.5.2");
  const preview = JSON.parse((await run("npm", ["pack", "--dry-run", "--json"])).stdout)[0];
  const paths: string[] = preview.files.map((file: { path: string }) => file.path);
  for (const path of ["package.json", "src/index.ts", "src/preferences.ts", "src/repositories.ts", "src/locales/en.ts", "src/locales/zh-CN.ts", "README.md", "README.zh-CN.md", "LICENSE"]) {
    assert.ok(paths.includes(path), path);
  }
  for (const path of paths) {
    assert.match(path, /^(?:src\/(?:locales\/)?[a-zA-Z-]+\.ts|package\.json|README(?:\.zh-CN)?\.md|LICENSE)$/);
  }
  const destination = await realpath(await mkdtemp(join(home, "archive-")));
  const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", destination])).stdout)[0];
  assert.deepEqual(packed.files, preview.files);
  const archive = join(destination, packed.filename);
  const entries = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n").map(path => path.replace(/^package\//, ""));
  assert.deepEqual(entries.sort(), paths.sort());
  const license = (await run("tar", ["-xOf", archive, "package/LICENSE"])).stdout;
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 nosweet789\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  context.diagnostic(JSON.stringify({ archive: packed.filename, bytes: packed.size, shasum: packed.shasum, files: paths }));
});

test("temporary local loading preserves pi settings and persists extension preferences", async () => {
  const workspace = await fixture();
  const settingsPath = join(workspace.agentDir, "settings.json");
  const settingsText = JSON.stringify(initialSettings, null, 2) + "\n";
  await writeFile(settingsPath, settingsText);
  const packagePath = await realpath(sourceRoot);
  const args = ["--no-extensions", "-e", packagePath];
  assert.equal(await inspectLoaded(workspace, args), packagePath);
  assert.equal(await readFile(settingsPath, "utf8"), settingsText);
  await inspectLoaded(workspace, args, "zh-CN");
  assert.equal(await readFile(settingsPath, "utf8"), settingsText);
  assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "committed\n");
});

test("pi local installation changes only the requested package declaration and rejects missing sources", async () => {
  const workspace = await fixture();
  const settingsPath = join(workspace.agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2) + "\n");
  const packagePath = await realpath(sourceRoot);
  const env = { ...environment, PI_CODING_AGENT_DIR: workspace.agentDir };
  await assert.rejects(run(process.execPath, [cliPath, "install", join(workspace.root, "missing-package")], workspace.cwd, env));
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), initialSettings);
  await run(process.execPath, [cliPath, "install", packagePath], workspace.cwd, env);
  const installedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  const { packages, ...otherSettings } = installedSettings;
  assert.deepEqual(otherSettings, initialSettings);
  assert.equal(packages.length, 1);
  assert.equal(resolve(workspace.agentDir, packages[0]), packagePath);
  assert.equal(await inspectLoaded(workspace), packagePath);
  await inspectLoaded(workspace, [], "zh-CN");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), installedSettings);
  await run(process.execPath, [cliPath, "remove", packagePath], workspace.cwd, env);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { ...initialSettings, packages: [] });
});

async function verifyInstalledRuntime(installed: string) {
  const result = await run(process.execPath, ["--import", "./test/isolate.mjs", "--import", "tsx", "--test", "--test-concurrency=1",
    "test/checkpoints.test.ts", "test/restore.test.ts", "test/diff-views.test.ts", "test/inheritance-views.test.ts",
    "test/restore-preference.test.ts", "test/restore-toggle.test.ts", "test/restore-concurrency.test.ts",
    "test/status.test.ts", "test/model-context.test.ts", "test/restart.test.ts",
    "test/nested-repositories.test.ts", "test/nested-discovery.test.ts", "test/nested-inheritance.test.ts", "test/nested-safety.test.ts", "test/nested-review.test.ts"],
  sourceRoot, { ...environment, TREE_VERSIONING_TEST_PACKAGE: installed });
  return "Installed artifact: checkpoints, queries, restoration switch, status tool, persistence, diff UI, inherited bilingual cards, nested repository coverage\n" +
    result.stdout.split("\n").filter(line => /^(?:ℹ|# (?:tests|pass|fail|skipped))/.test(line)).join("\n");
}

async function assertRuntimeDependencies(installed: string) {
  const files = await readdir(join(installed, "node_modules"), { recursive: true });
  assert.ok(files.includes("diff/package.json"), "The declared runtime dependency must be installed");
  assert.ok(!files.some(path => /(?:^|\/)(?:@earendil-works|typebox)(?:\/|$)/.test(path)), "Host packages must not be installed");
}

test("a standalone checkout passes the full suite and supports permanent and temporary Git installation", async context => {
  const workspace = await fixture();
  const repository = join(workspace.root, "distribution");
  const checkout = join(workspace.root, "checkout");
  await mkdir(repository);
  // Include uncommitted development changes without modifying the source repository or its index.
  const paths = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  for (const path of paths) {
    assert.ok((await lstat(join(sourceRoot, path))).isFile(), `Distribution inputs must be regular files: ${path}`);
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await copyFile(join(sourceRoot, path), join(repository, path));
  }
  await run("git", ["init", "-q"], repository);
  await run("git", ["add", "."], repository);
  await run("git", ["-c", "user.name=Package Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test: create distribution fixture"], repository);
  const commit = (await run("git", ["rev-parse", "HEAD"], repository)).stdout.trim();
  await run("git", ["clone", "--no-local", repository, checkout], workspace.root);
  await run("npm", ["ci", "--no-audit", "--no-fund"], checkout);
  await run("npm", ["run", "build"], checkout);
  const regression = await run("npm", ["test"], checkout);
  context.diagnostic("Standalone checkout: npm ci; npm run build; npm test\n" +
    regression.stdout.split("\n").filter(line => /^(?:ℹ|# (?:tests|pass|fail|skipped))/.test(line)).join("\n"));

  // A reserved test URL is mapped to a local repository only in this isolated Git config.
  const url = "https://packages.invalid/tests/tree-versioning";
  const config = join(workspace.root, "gitconfig");
  await run("git", ["config", "--file", config, `url.file://${repository}.insteadOf`, url]);
  const source = `git:${url}@${commit}`;
  const settingsPath = join(workspace.agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2) + "\n");
  const env = { ...environment, PI_CODING_AGENT_DIR: workspace.agentDir, GIT_CONFIG_GLOBAL: config, GIT_ALLOW_PROTOCOL: "file" };

  const temporaryWorkspace = await fixture();
  const temporarySettingsPath = join(temporaryWorkspace.agentDir, "settings.json");
  const settingsText = JSON.stringify(initialSettings, null, 2) + "\n";
  await writeFile(temporarySettingsPath, settingsText);
  // Resolve the temporary source through the host without starting model/catalog services.
  // Offline CLI startup deliberately skips installation of uncached sources.
  await run(process.execPath, ["--input-type=module", "-e", `
    import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
    const [cwd, agentDir, source] = process.argv.slice(1);
    const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
    const result = await packages.resolveExtensionSources([source], { temporary: true });
    if (result.installFailures?.length || result.extensions.length !== 1) throw new Error(JSON.stringify(result));
  `, temporaryWorkspace.cwd, temporaryWorkspace.agentDir, source], sourceRoot,
  { ...env, PI_CODING_AGENT_DIR: temporaryWorkspace.agentDir, PI_OFFLINE: "0" });
  assert.equal(await readFile(temporarySettingsPath, "utf8"), settingsText);
  const temporaryArgs = ["--no-extensions", "-e", source];
  const temporaryInstalled = await inspectLoaded(temporaryWorkspace, temporaryArgs);
  assert.ok(temporaryInstalled.startsWith(temporaryWorkspace.agentDir + "/"));
  assert.equal((await run("git", ["rev-parse", "HEAD"], temporaryInstalled)).stdout.trim(), commit);
  await assertRuntimeDependencies(temporaryInstalled);
  await inspectLoaded(temporaryWorkspace, temporaryArgs, "zh-CN");
  assert.equal(await readFile(temporarySettingsPath, "utf8"), settingsText);

  await assert.rejects(run(process.execPath, [cliPath, "install", `git:${url}@missing-test-ref`], workspace.cwd, env));
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), initialSettings);
  await run(process.execPath, [cliPath, "install", source], workspace.cwd, env);
  const installedSettings = { ...initialSettings, packages: [source] };
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), installedSettings);
  const installed = await inspectLoaded(workspace);
  assert.ok(installed.startsWith(workspace.agentDir + "/"));
  assert.equal((await run("git", ["rev-parse", "HEAD"], installed)).stdout.trim(), commit);
  await assertRuntimeDependencies(installed);
  context.diagnostic(await verifyInstalledRuntime(installed));
  await inspectLoaded(workspace, [], "zh-CN");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), installedSettings);
  await run(process.execPath, [cliPath, "remove", source], workspace.cwd, env);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { ...initialSettings, packages: [] });
});
