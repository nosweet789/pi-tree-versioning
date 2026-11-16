import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispose, load, type Fixture } from "./harness.ts";

const fixture: Fixture = JSON.parse(process.argv[2]);
const app = await load(fixture, SessionManager.open(process.argv[3]));
try {
  await app.command("help");
  console.log(JSON.stringify({ diff: (await app.diff()).details, checkpoints: (await app.checkpoints()).details,
    total: (await app.diff({ scope: "session" })).details,
    status: (await app.query("tree_versioning_status")).structuredContent, notice: app.notices.at(-1)?.message }));
} finally { dispose(app.session); }
