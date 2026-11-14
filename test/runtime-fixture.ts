import { AgentSessionRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { load, type Fixture } from "./harness.ts";
import type { TestApp } from "./agent-fixture.ts";

export async function loadRuntime(workspace: Fixture, manager?: SessionManager,
  options: Parameters<typeof load>[2] = {},
  replacementOptions: Parameters<typeof load>[2] & { beforeLoad?: (manager: SessionManager) => Promise<void> } = {}) {
  let app = await load(workspace, manager, options);
  const services = (current: TestApp) => ({
    cwd: workspace.cwd, agentDir: workspace.agentDir,
    modelRuntime: current.modelRuntime, settingsManager: current.session.settingsManager,
    resourceLoader: current.session.resourceLoader, diagnostics: [],
  });
  const runtime = new AgentSessionRuntime(app.session, services(app), async replacement => {
    await replacementOptions.beforeLoad?.(replacement.sessionManager);
    app = await load(workspace, replacement.sessionManager, { ...options, ...replacementOptions, sessionStartEvent: replacement.sessionStartEvent });
    return { session: app.session, services: services(app), diagnostics: [],
      extensionsResult: app.session.resourceLoader.getExtensions() };
  });
  return { runtime, get app() { return app; } };
}
