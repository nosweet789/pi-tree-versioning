import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { fixture } from "./harness.ts";
import { loadRuntime } from "./runtime-fixture.ts";
import { nativeUi } from "./native-ui-fixture.ts";
import { responseStream, useModel } from "./agent-fixture.ts";

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} native custom UI restores the actual editor and keeps browsing read-only`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace);
    const startUi = nativeUi(t, host, mode, 100, 30);
    await useModel(host.app, () => responseStream({ content: [{ type: "text", text: "Recorded." }] }));
    await writeFile(join(workspace.cwd, "notes.txt"), "first saved line\nlast saved line\n");
    await host.app.session.prompt("Record native UI sample.");
    host.app.session.agent.streamFunction = () => { throw new Error("Browsing must not start a model"); };
    const view = await startUi();
    const { ui, screen, input } = view;
    ui.setWidget("test-above", ["Above input"]);
    ui.setWidget("test-below", ["Below input"], { placement: "belowEditor" });
    ui.setFooter(() => new Text("Native footer", 0, 0));
    ui.setEditorText("Original input\nUnsubmitted second line");
    const entries = host.app.manager.getEntries();
    const comparison = (await host.app.diff({ scope: "session" })).details;
    const pending = host.app.session.prompt("/tree-versioning-diff");
    try {
      for (let attempt = 0; attempt < 200 && !screen().includes("Saved session diff"); attempt++) await setTimeout(5);
      assert.match(screen(), /Saved session diff/);
      assert.equal(view.hasOverlay(), false);
      assert.doesNotMatch(screen(), /Unsubmitted second line/);
      input("\x0f");
      assert.match(screen(), /\+last saved line/);
      assert.match(screen(), /Below input[\s\S]*Native footer/);
    } finally {
      input("\x1b");
      await pending;
    }
    assert.equal(ui.getEditorText(), "Original input\nUnsubmitted second line");
    assert.match(screen(), /Unsubmitted second line/);
    assert.doesNotMatch(screen(), /Saved session diff/);
    input("!");
    assert.equal(ui.getEditorText(), "Original input\nUnsubmitted second line!");
    assert.deepEqual(host.app.manager.getEntries(), entries);
    assert.deepEqual((await host.app.diff({ scope: "session" })).details, comparison);
    assert.match(view.output, /Saved session diff/);
  });
}
