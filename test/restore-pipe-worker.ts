import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

const workspace = await fixture();
await mkdir(join(workspace.cwd, "nested"));
await writeFile(join(workspace.cwd, "nested", "first.txt"), "saved child\n");
for (let index = 0; index < 1800; index++) {
  await writeFile(join(workspace.cwd, `z-${index}-${"long-name-".repeat(18)}.txt`), "saved\n");
}
const app = await load(workspace);
try {
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
  await app.session.prompt("Record many paths.");
  const target = ((await app.checkpoints()).details as any).checkpoints[0];
  await rm(join(workspace.cwd, "nested"), { recursive: true });
  await mkdir(join(workspace.cwd, "local-target"));
  await symlink("local-target", join(workspace.cwd, "nested"));
  await writeFile(join(workspace.cwd, "notes.txt"), "manual edit stays\n");
  await app.session.navigateTree(target.nodeId, { summarize: false });
  assert.equal(app.manager.getLeafId(), target.nodeId);
  assert.equal(await readFile(join(workspace.cwd, "notes.txt"), "utf8"), "manual edit stays\n");
  assert.equal(app.notices.at(-1)!.type, "error");
  assert.match(app.notices.at(-1)!.message, /restoration failed/);
  console.log("Restore failure reported; host still running.");
} finally { dispose(app.session); }
