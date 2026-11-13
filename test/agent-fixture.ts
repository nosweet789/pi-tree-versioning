import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { load } from "./harness.ts";

export type TestApp = Awaited<ReturnType<typeof load>>;
export type Response = Pick<AssistantMessage, "content"> & Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>;

export function assistant(response: Response): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "integration-test", model: "fixture",
    stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...response,
  };
}

export function responseStream(response: Response) {
  const stream = createAssistantMessageEventStream();
  const message = assistant(response);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
  }
  return stream;
}

export async function useModel(app: TestApp, respond: TestApp["session"]["agent"]["streamFunction"]) {
  app.modelRuntime.registerProvider("integration-test", {
    api: "openai-completions", apiKey: "test-only", baseUrl: "https://unused.invalid",
    models: [{
      id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
  });
  await app.session.setModel(app.modelRuntime.getModel("integration-test", "fixture")!);
  app.session.agent.streamFunction = respond;
}
