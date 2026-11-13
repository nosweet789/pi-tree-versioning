import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("both read-only tools reach model context while automatic file history records do not", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "model-visible change\n");
    const requests: unknown[] = [];
    await useModel(app, async (_model, context) => {
      requests.push(context.messages);
      if (requests.length <= 2) assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 0);
      return responseStream(requests.length === 1
        ? { stopReason: "toolUse", content: [
          { type: "toolCall", id: "diff-call", name: "session_diff", arguments: { scope: "workspace" } },
          { type: "toolCall", id: "checkpoints-call", name: "session_checkpoints", arguments: {} },
        ] }
        : { content: [{ type: "text", text: "Done." }] });
    });
    await app.session.prompt("Read file history.");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /model-visible change/);
    const toolResults = app.session.messages.filter(message => message.role === "toolResult");
    assert.equal(toolResults.length, 2);
    assert.ok(toolResults.every(result => !result.isError));
    assert.deepEqual((toolResults.find(result => result.toolName === "session_checkpoints")!.details as { checkpoints: unknown[] }).checkpoints, []);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 1);
    await app.session.prompt("Continue without querying.");
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests), /tree-versioning\.(baseline|checkpoint)/);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 2);
    assert.deepEqual(app.session.getActiveToolNames().sort(), ["read", "bash", "edit", "write", "session_diff", "session_checkpoints"].sort());
  } finally { dispose(app.session); }
});
