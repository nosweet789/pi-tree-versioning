import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispose, load, type Fixture } from "./harness.ts";

const workspace: Fixture = JSON.parse(process.argv[2]);
const app = await load(workspace, SessionManager.open(process.argv[3]));
try {
  const initial = await readFile(join(workspace.cwd, "notes.txt"), "utf8");
  const catalog = (await app.checkpoints()).details;
  const total = (await app.diff({ scope: "session" })).details;
  const restored = [];
  for (const nodeId of JSON.parse(process.argv[4]) as string[]) {
    await app.session.navigateTree(nodeId, { summarize: false });
    restored.push(await readFile(join(workspace.cwd, "notes.txt"), "utf8"));
  }
  console.log(JSON.stringify({ initial, catalog, total, restored, errors: app.errors }));
} finally { dispose(app.session); }
