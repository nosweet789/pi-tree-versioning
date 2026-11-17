import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./harness.ts";
import { nestedRepository, setDepth } from "./nested-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";
import { loadRuntime } from "./runtime-fixture.ts";

for (const operation of ["fork", "clone"] as const) {
  for (const restoreEnabled of [true, false]) {
    test(`${operation} inherits frozen nested coverage independently of preferences and source storage (restore: ${restoreEnabled})`, async () => {
      const workspace = await fixture();
      const nested = await nestedRepository(workspace);
      await writeFile(join(workspace.cwd, ".gitignore"), "/nested/\n");
      await setDepth(workspace, 1);
      const host = await loadRuntime(workspace);
      try {
        await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Done." }] }));
        await writeFile(join(nested, "notes.txt"), "nested saved\n");
        await host.app.session.prompt("Save the nested repository.");
        const source = (await host.app.checkpoints()).details as any;
        const baselineNode = host.app.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "tree-versioning.baseline")!.id;
        const user = host.app.manager.appendMessage({ role: "user", content: "Fork here", timestamp: Date.now() });
        await host.app.session.prompt("/tree-versioning-repository-depth 0");
        if (!restoreEnabled) await host.app.session.prompt("/tree-versioning-restore off");
        await writeFile(join(nested, "notes.txt"), "nested manual\n");
        await host.runtime.fork(user, { position: operation === "fork" ? "before" : "at" });
        const child = (await host.app.checkpoints()).details as any;
        assert.notEqual(child.sessionId, source.sessionId);
        assert.deepEqual(child.coverage, { searchDepth: 1, repositories: [".", "nested"] });
        assert.equal(child.baseline.id, source.baseline.id);
        assert.equal(child.checkpoints[0].id, source.checkpoints[0].id);
        assert.equal(await readFile(join(nested, "notes.txt"), "utf8"),
          operation === "fork" && restoreEnabled ? "nested saved\n" : "nested manual\n");
        await rm(join(workspace.agentDir, "tree-versioning", source.sessionId), { recursive: true });
        await host.app.session.reload();
        const total = await host.app.diff({ scope: "session" });
        assert.equal(total.isError, false, JSON.stringify(total));
        assert.match((total.details as any).files[0].patch, /-nested before\n\+nested saved/);
        await host.app.session.prompt("/tree-versioning-restore on");
        await host.app.session.navigateTree(baselineNode, { summarize: false });
        assert.equal(await readFile(join(nested, "notes.txt"), "utf8"), "nested before\n");
      } finally { await host.runtime.dispose(); }
    });
  }
}
