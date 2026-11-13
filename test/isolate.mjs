import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-tree-versioning-tests-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
process.env.TMPDIR = join(home, "tmp");
mkdirSync(process.env.TMPDIR);
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.LC_ALL = "en_US.UTF-8";
delete process.env.LANGUAGE;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key)) delete process.env[key];
}
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
