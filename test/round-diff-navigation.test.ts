import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { responseStream, useModel } from "./agent-fixture.ts";
import { dispose, fixture, load } from "./harness.ts";
import { nativeUi } from "./native-ui-fixture.ts";
import { loadRuntime } from "./runtime-fixture.ts";

async function waitFor(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await setTimeout(5);
  }
  assert.fail(description);
}

function nativeTree(t: TestContext, host: Awaited<ReturnType<typeof loadRuntime>>, mode: "regular" | "fullscreen") {
  const start = nativeUi(t, host, mode);
  return async () => {
    const view = await start();
    const { ui, input, screen } = view;
    const openTree = async () => {
      ui.setEditorText("/tree");
      input("\r");
      await waitFor(() => screen().includes("Session Tree"), "Native tree selector did not open");
    };
    return {
      ...view, openTree,
      async select(search: string) {
        await openTree();
        input(search);
        assert.match(screen(), /\(1\/1\)/, "The native selector should have one matching entry");
        input("\r");
        await waitFor(() => screen().includes("Summarize branch?"), "Native summary choice did not open");
        input("\r"); // No summary.
      },
    };
  };
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} /tree shows the same saved round diff at the checkpoint and before the next user message`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    const host = await loadRuntime(workspace);
    const startUi = nativeTree(t, host, mode);
    const { app } = host;
    const notes = join(workspace.cwd, "notes.txt");
    const midRoundReply = "About to save the first change.";
    const firstReply = "First saved response.";
    const secondUserText = "Continue with the second change.";
    const secondReply = "Second saved response.";
    const firstSavedFileDetails = /1 file changed: 1 modified\. *\n *notes\.txt · Modified · \+1 -1/;
    let requests = 0;
    await useModel(app, () => responseStream(++requests === 1 ? {
      content: [{ type: "text", text: midRoundReply },
        { type: "toolCall", id: "save-first", name: "write", arguments: { path: "notes.txt", content: "first saved line\n" } }],
      stopReason: "toolUse",
    } : { content: [{ type: "text", text: requests === 2 ? firstReply : secondReply }] }));
    await app.session.prompt("Save the first change.");
    const firstCardLeaf = app.manager.getLeafId();
    const firstAssistant = app.manager.getBranch().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
    const midRoundAssistant = app.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
    assert.ok(firstAssistant && midRoundAssistant && firstAssistant.id !== midRoundAssistant.id);
    const firstDiff = (await app.diff({ scope: "turn" })).details;
    await writeFile(notes, "second saved line\n");
    await app.session.prompt(secondUserText);
    const entries = app.manager.getEntries();
    app.session.agent.streamFunction = () => { throw new Error("Navigation must not start a model"); };

    const { select, screen, ui, input } = await startUi();
    await select(firstReply);
    await waitFor(() => app.manager.getLeafId() === firstAssistant.id && !screen().includes(secondReply),
      "Pi did not render the branch at the first assistant message");
    assert.equal(await readFile(notes, "utf8"), "first saved line\n");
    assert.deepEqual((await app.diff({ scope: "turn" })).details, firstDiff);
    assert.equal(screen().match(/Round diff/g)?.length, 1, "The checkpoint should show its saved round diff");
    assert.match(screen(), firstSavedFileDetails);
    assert.doesNotMatch(screen(), /\+first saved line/);
    input("\x0f");
    assert.match(screen(), /-committed[\s\S]*\+first saved line/);
    assert.doesNotMatch(screen(), /second saved line/);
    input("\x0f");
    assert.doesNotMatch(screen(), /\+first saved line/);

    await select(secondUserText);
    await waitFor(() => app.manager.getLeafId() === firstCardLeaf && ui.getEditorText() === secondUserText,
      "Pi did not land before the user message and prefill its text");
    assert.equal(screen().match(/Round diff/g)?.length, 1, "The saved entry must not be shown twice");
    assert.match(screen(), firstSavedFileDetails);
    input("\x0f");
    assert.match(screen(), /-committed[\s\S]*\+first saved line/);
    assert.doesNotMatch(screen(), /second saved line/);
    assert.deepEqual((await app.diff({ scope: "turn" })).details, firstDiff);
    input("\x0f");

    await app.session.prompt("/tree-versioning-restore off");
    await app.command("zh-CN");
    await writeFile(notes, "unsnapshotted edit\n");
    await select(firstReply);
    await waitFor(() => app.manager.getLeafId() === firstAssistant.id && screen().includes("Navigated to selected point"),
      "Pi did not land at the checkpoint with restoration disabled");
    assert.equal(screen().match(/轮次差异/g)?.length, 1);
    assert.match(screen(), /1 个文件有变化：修改 1 个。/);
    assert.doesNotMatch(screen(), /\+first saved line/);
    input("\x0f");
    assert.match(screen(), /-committed[\s\S]*\+first saved line/);
    assert.doesNotMatch(screen(), /unsnapshotted edit/);
    assert.equal(await readFile(notes, "utf8"), "unsnapshotted edit\n");
    assert.deepEqual((await app.diff({ scope: "turn" })).details, firstDiff);

    ui.setEditorText("/reload");
    input("\r");
    await waitFor(() => screen().includes("Reloaded keybindings"), "Pi did not reload the extension");
    assert.equal(app.manager.getLeafId(), firstAssistant.id);
    assert.equal(screen().match(/轮次差异/g)?.length, 1, "Reload must retain the round diff at the checkpoint");
    assert.match(screen(), /\+first saved line/);

    await select(midRoundReply);
    await waitFor(() => app.manager.getLeafId() === midRoundAssistant.id && !screen().includes(firstReply),
      "Pi did not render the mid-round assistant branch");
    assert.doesNotMatch(screen(), /Round diff|轮次差异|\+first saved line|\+second saved line/);
    assert.equal(await readFile(notes, "utf8"), "unsnapshotted edit\n");
    assert.deepEqual(app.manager.getEntries(), entries);
  });
}

test("fullscreen can browse an overflowing round diff without losing the editor or intercepting Pi's keys", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  await writeFile(join(workspace.agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": "alt+pageDown" }));
  const startUi = nativeTree(t, host, "fullscreen");
  const { app } = host;
  let text = "Recorded the long diff.";
  await useModel(app, () => responseStream({ content: [{ type: "text", text }] }));
  const notes = ["first patch line", ...Array.from({ length: 80 }, (_, i) => `added line ${i + 1}`), "last patch line"];
  await writeFile(join(workspace.cwd, "notes.txt"), notes.join("\n") + "\n");
  await app.session.prompt("Record a long patch.");
  text = "Recorded the next round.";
  await app.session.prompt("Carry on.");
  const { select, openTree, screen, ui, input, resize } = await startUi();
  await select("Recorded the long diff.");
  await waitFor(() => screen().includes("Navigated to selected point"), "Pi did not render the selected checkpoint");
  const draft = "An unsubmitted draft\nsecond line\nthird line\nfourth line\nfifth line";
  ui.setEditorText(draft);
  resize(120, 14);
  assert.match(screen(), /\/tree-versioning-diff round/, "A clipped file summary should advertise the full viewer");
  assert.match(screen(), /fifth line/);
  resize(24, 13);
  assert.doesNotMatch(screen(), /\/tree-versioning-diff/, "Never suggest the session command by clipping its round argument");
  assert.match(screen(), /Widen for full diff/);
  await app.command("zh-CN");
  assert.match(screen(), /加宽窗口查看完整差异/);
  assert.doesNotMatch(screen(), /\/tree-versioning-diff/);
  await app.command("en");
  resize(27, 13);
  assert.match(screen(), /^\/tree-versioning-diff round\s*$/m, "Keep the whole command together when it just fits");
  resize(120, 36);
  const toggle = "\x1b[6;3~"; // Alt+PageDown, the configured Pi action.
  assert.doesNotMatch(screen(), /\+first patch line/);
  input(toggle);
  assert.match(screen(), /\+first patch line/);

  resize(160, 24);
  await openTree();
  input("\x1b[6~"); // PageDown to the last row.
  assert.match(screen(), /›[^\n]*Recorded the next round/);
  input("\x1b");
  ui.setEditorText(draft);
  resize(80, 14);
  assert.match(screen(), /\/tree-versioning-diff round/);
  assert.match(screen(), /fifth line/);

  const pending = app.session.prompt("/tree-versioning-diff round");
  try {
    await waitFor(() => /escape(?:\/ctrl\+c)? close/.test(screen()), "The full round diff viewer did not open");
    assert.equal(screen().match(/Round diff/g)?.length, 1);
    input(toggle);
    for (let page = 0; page < 40 && !screen().includes("+last patch line"); page++) {
      input("\x1b[6~"); // PageDown.
    }
    assert.match(screen(), /\+last patch line/);
  } finally {
    input("\x1b");
    await pending;
  }
  assert.equal(ui.getEditorText(), draft);
  assert.match(screen(), /Round diff/);

  resize(120, 36);
  const sessionViewer = app.session.prompt("/tree-versioning-diff");
  try {
    await waitFor(() => screen().includes("Saved session diff"), "The default saved session diff viewer did not open");
    assert.doesNotMatch(screen(), /Round diff|An unsubmitted draft/);
  } finally {
    input("\x1b");
    await sessionViewer;
  }
  assert.equal(ui.getEditorText(), draft);
  assert.equal(screen().match(/Round diff/g)?.length, 1, "Closing the session viewer should restore the round diff once");
  assert.match(screen(), /\+first patch line/, "The round diff keeps Pi's expansion state");
  input(toggle);
  assert.match(screen(), /notes.txt.*\+82.*-1/);
  assert.doesNotMatch(screen(), /\+first patch line|\+last patch line/);
});

test("/tree shows the saved diff of an inherited checkpoint whose card was not copied", { timeout: 10_000 }, async t => {
  const workspace = await fixture();
  const host = await loadRuntime(workspace);
  const startUi = nativeTree(t, host, "regular");
  const notes = join(workspace.cwd, "notes.txt");
  const reply = "Checkpoint inherited from source.";
  await useModel(host.app, () => responseStream({ content: [{ type: "text", text: reply }] }));
  await writeFile(notes, "inherited line\n");
  await host.app.session.prompt("Save the source round.");
  const sourceCard = host.app.manager.getLeafId();
  const assistant = host.app.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(assistant);
  assert.equal((await host.runtime.fork(assistant.id, { position: "at" })).cancelled, false);
  const { app } = host;
  assert.ok(!app.manager.getEntries().some(entry => entry.id === sourceCard));
  await useModel(app, () => responseStream({ content: [{ type: "text", text: "Saved in child." }] }));
  await writeFile(notes, "child line\n");
  await app.session.prompt("Save a child round.");
  await app.session.prompt("/tree-versioning-restore off");
  const entries = app.manager.getEntries();
  const { select, screen, input } = await startUi();
  await select(reply);
  await waitFor(() => screen().includes("Navigated to selected point"), "Pi did not land at the inherited checkpoint");
  assert.equal(app.manager.getLeafId(), assistant.id);
  assert.equal(screen().match(/Round diff/g)?.length, 1);
  input("\x0f");
  assert.match(screen(), /-committed[\s\S]*\+inherited line/);
  assert.doesNotMatch(screen(), /\+child line/);
  assert.equal(await readFile(notes, "utf8"), "child line\n");
  assert.deepEqual(app.manager.getEntries(), entries);
});

type SavedCard = { parentId: string | null; data: { nodeId: string; diff: unknown } };
function misdirectEndpoint(card: SavedCard, node: string) {
  const diff = card.data.diff as { to: { nodeId: string } };
  diff.to.nodeId = node;
}
const damageCases: {
  name: string;
  alter(card: SavedCard, earlierNode: string): void;
  alterLater?(card: SavedCard, checkpointNode: string): void;
  midRound?: "unavailable" | "no preview";
  narrow?: boolean;
}[] = [
  { name: "invalid diff data", alter: card => { card.data.diff = { status: "ok", files: [] }; }, narrow: true },
  { name: "a missing parent", alter: card => { card.parentId = "missing-parent"; } },
  { name: "a wrong parent", alter: (card, earlierNode) => { card.parentId = earlierNode; } },
  {
    name: "an association to a mid-round node and a conflicting later card",
    alter(card, earlierNode) { card.data.nodeId = earlierNode; },
    alterLater: misdirectEndpoint,
    midRound: "unavailable",
  },
  { name: "a diff endpoint pointing to an unsaved node", alter: misdirectEndpoint, midRound: "no preview" },
];

for (const { name, alter, alterLater, midRound, narrow } of damageCases) {
  test(`/tree localizes the unavailable state for a card with ${name}`, { timeout: 10_000 }, async t => {
    const workspace = await fixture();
    const original = await load(workspace);
    let sessionFile: string;
    let cardId: string | null;
    let laterCardId: string | null;
    let midRoundNodeId: string;
    const midRoundReply = "Inspecting a file mid-round.";
    const reply = "Round with a damaged card.";
    const laterReply = "Continue after the damaged card.";
    try {
      let text = reply;
      let requests = 0;
      await useModel(original, () => responseStream(++requests === 1 ? {
        content: [{ type: "text", text: midRoundReply },
          { type: "toolCall", id: "read-notes", name: "read", arguments: { path: "notes.txt" } }],
        stopReason: "toolUse",
      } : { content: [{ type: "text", text }] }));
      await writeFile(join(workspace.cwd, "notes.txt"), "saved change\n");
      await original.session.prompt("Save a change.");
      const midRoundNode = original.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
      assert.ok(midRoundNode);
      midRoundNodeId = midRoundNode.id;
      cardId = original.manager.getLeafId();
      text = laterReply;
      await original.session.prompt("One more round.");
      laterCardId = original.manager.getLeafId();
      await original.session.prompt("/tree-versioning-restore off");
      await original.command("zh-CN");
      sessionFile = original.manager.getSessionFile()!;
    } finally { dispose(original.session); }
    const persisted = (await readFile(sessionFile, "utf8")).trimEnd().split("\n");
    const cardIndex = persisted.findIndex(line => JSON.parse(line).id === cardId);
    assert.ok(cardIndex >= 0);
    const entry: SavedCard = JSON.parse(persisted[cardIndex]);
    const checkpointNode = entry.data.nodeId;
    alter(entry, midRoundNodeId);
    persisted[cardIndex] = JSON.stringify(entry);
    if (alterLater) {
      const laterIndex = persisted.findIndex(line => JSON.parse(line).id === laterCardId);
      assert.ok(laterIndex > cardIndex);
      const later: SavedCard = JSON.parse(persisted[laterIndex]);
      alterLater(later, checkpointNode);
      persisted[laterIndex] = JSON.stringify(later);
    }
    await writeFile(sessionFile, persisted.join("\n") + "\n");

    const host = await loadRuntime(workspace, SessionManager.open(sessionFile));
    const { select, screen, ui, resize } = await nativeTree(t, host, narrow ? "fullscreen" : "regular")();
    const history = await readFile(sessionFile);
    const visit = async (target: string, node: string, expected: "unavailable" | "no preview") => {
      await select(target);
      await waitFor(() => {
        const visible = screen();
        return host.app.manager.getLeafId() === node && visible.includes("Navigated to selected point") &&
          !visible.includes(laterReply) && (node === checkpointNode || !visible.includes(reply));
      }, "Pi did not render the selected branch");
      if (expected === "unavailable") assert.match(screen(), /已保存的差异展示数据不可用/);
      else assert.doesNotMatch(screen(), /已保存的差异展示数据不可用/, "An endpoint alone must not imply a checkpoint");
      assert.doesNotMatch(screen(), /轮次差异|没有文件变化|Invalid native ancestry/);
    };
    await visit(reply, checkpointNode, "unavailable");
    if (midRound) await visit(midRoundReply, midRoundNodeId, midRound);
    if (narrow) {
      ui.setEditorText("one\ntwo\nthree\nfour\nfive");
      resize(24, 13);
      assert.match(screen(), /差异不可用/);
      assert.doesNotMatch(screen(), /加宽窗口|\/tree-versioning-diff/);
      await host.app.command("en");
      assert.match(screen(), /Diff unavailable/);
      assert.doesNotMatch(screen(), /Widen for full diff|\/tree-versioning-diff/);
    }
    assert.ok((await readFile(sessionFile)).equals(history), "Navigation must not rewrite session history");
  });
}
