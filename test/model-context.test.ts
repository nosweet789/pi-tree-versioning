import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { dispose, fixture, load } from "./harness.ts";

test("a deterministic real agent run sees query results but baseline metadata is not injected into model context", async () => {
  const testWorkspace = await fixture();
  const app = await load(testWorkspace);
  try {
    app.modelRuntime.registerProvider("integration-test", {
      api: "openai-completions", apiKey: "test-only", baseUrl: "https://unused.invalid",
      models: [{
        id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 4096,
      }],
    });
    await app.session.setModel(app.modelRuntime.getModel("integration-test", "fixture")!);
    await writeFile(join(testWorkspace.cwd, "notes.txt"), "model-visible change\n");
    const requests: unknown[] = [];
    app.session.agent.streamFunction = (_model, context) => {
      requests.push(context.messages);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "integration-test", model: "fixture",
        content: requests.length === 1
          ? [{ type: "toolCall", id: "query-call", name: "session_diff", arguments: { scope: "workspace" } }]
          : [{ type: "text", text: "Done." }],
        stopReason: requests.length === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };
    const customBefore = app.manager.getEntries().filter(entry => entry.type === "custom");
    await app.session.prompt("Read unsnapshotted changes.");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests[0]), /tree-versioning\.baseline/);
    assert.match(JSON.stringify(requests[1]), /model-visible change/);
    const toolResults = app.session.messages.filter(message => message.role === "toolResult");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].isError, false);
    assert.deepEqual(app.manager.getEntries().filter(entry => entry.type === "custom"), customBefore);
    assert.deepEqual(app.session.getActiveToolNames(), ["read", "bash", "edit", "write", "session_diff"]);
  } finally { dispose(app.session); }
});
