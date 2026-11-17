import fs, { access, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { dispose, load, type Fixture } from "./harness.ts";

const [serialized, barrier, identity, command] = process.argv.slice(2);
const workspace = JSON.parse(serialized) as Fixture;
const preferencePath = join(workspace.agentDir, "tree-versioning", "preferences.json");
const read = fs.readFile;
let saving = false;
// Widen the filesystem read/write race across real processes, not internal collaborators.
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const result = await read(...args);
  if (saving && args[0] === preferencePath) await setTimeout(200);
  return result;
}) as typeof fs.readFile;
syncBuiltinESMExports();
const app = await load(workspace);
try {
  await writeFile(join(barrier, identity), "ready");
  while (!await access(join(barrier, "start")).then(() => true, () => false)) await setTimeout(5);
  saving = true;
  await app.session.prompt(command);
  if (app.notices.some(notice => notice.type === "error")) throw new Error(JSON.stringify(app.notices));
} finally { dispose(app.session); }
