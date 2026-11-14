import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispose, fixture, load } from "./harness.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

test("automatic cards remain outside actual model requests across language changes and reloads", async () => {
  const workspace = await fixture();
  const app = await load(workspace);
  try {
    const requests: unknown[] = [];
    const respond: Parameters<typeof useModel>[1] = (_model, context) => {
      requests.push(context.messages);
      return responseStream({ content: [{ type: "text", text: "Done." }] });
    };
    await useModel(app, respond);
    await writeFile(join(workspace.cwd, "notes.txt"), "AUTOMATIC-CARD-ONLY-CONTENT\n");
    await app.session.prompt("Record a change without querying.");
    const visibleCards = () => app.manager.getEntries().filter(entry =>
      entry.type === "custom" && !!app.session.extensionRunner.getEntryRenderer(entry.customType));
    assert.equal(visibleCards().length, 1);
    assert.match(JSON.stringify(visibleCards()), /AUTOMATIC-CARD-ONLY-CONTENT/);
    await app.command("zh-CN");
    await app.session.prompt("/tree-versioning-diff help");
    await app.session.reload();
    await useModel(app, respond);
    await app.session.prompt("Continue without reading files.");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests), /AUTOMATIC-CARD-ONLY-CONTENT|tree-versioning\.(baseline|checkpoint|diff)/);
    assert.equal(visibleCards().length, 2);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 2);
  } finally { dispose(app.session); }
});

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
    assert.doesNotMatch(JSON.stringify(requests), /tree-versioning\.(baseline|checkpoint|diff)/);
    assert.equal(((await app.checkpoints()).details as any).checkpoints.length, 2);
    assert.deepEqual(app.session.getActiveToolNames().sort(), ["read", "bash", "edit", "write", "session_diff", "session_checkpoints"].sort());
  } finally { dispose(app.session); }
});
