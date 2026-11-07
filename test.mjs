// Self-check against a tiny fake interaction log. Run: node test.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { handle, mask, people, meetings, circle } from "./server/index.mjs";

const path = join(mkdtempSync(join(tmpdir(), "pp-")), "view.db");
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE interactions (rowid INTEGER PRIMARY KEY, domain TEXT, bundleId TEXT, startDate REAL);
CREATE TABLE entities (rowid INTEGER PRIMARY KEY, type TEXT, fields TEXT);
CREATE TABLE interactionEntities (interactionRowid INTEGER, entityRowid INTEGER, parameter TEXT);`);
const now = Date.now() / 1000 - 978307200, day = 86400;
const ent = (type, fields) => Number(db.prepare("INSERT INTO entities (type, fields) VALUES (?, ?)").run(type, JSON.stringify(fields)).lastInsertRowid);
const anna = ent("Person", { name: "Anna" }); ent("PersonHandle", { name: "Anna", type: "phone" });
const old = ent("Person", { name: "Old Friend" }); ent("PersonHandle", { name: "Old Friend", type: "email" });
const grp = ent("Person", { name: "Besties" }); ent("PersonHandle", { name: "Besties" }); // group: no handle type
const num = ent("Person", { name: "+49 172 1234567" }); ent("PersonHandle", { name: "+49 172 1234567", type: "phone" });
const bob = ent("Person", { name: "Bob" }); ent("PersonHandle", { name: "Bob", type: "phone" });
const add = (who, daysAgo, app = "net.whatsapp.WhatsApp", domain = "Messages") => {
  const i = Number(db.prepare("INSERT INTO interactions (domain, bundleId, startDate) VALUES (?, ?, ?)").run(domain, app, now - daysAgo * day).lastInsertRowid);
  for (const w of [].concat(who)) db.prepare("INSERT INTO interactionEntities VALUES (?, ?, 'recipients')").run(i, w);
};
for (let k = 0; k < 30; k++) add(anna, k % 10);
add(anna, 2, "com.apple.InCallService", "Calls");
for (let k = 0; k < 25; k++) add(old, 100 + k);
for (let k = 0; k < 40; k++) add(grp, 1);
for (let k = 0; k < 5; k++) add(num, 3);
for (let k = 0; k < 50; k++) add([anna, bob, old], 1); // 3-person group thread: not 1:1
db.close();

// Fake knowledge graph + family scorecard. Ids above 2^53 on purpose: they must survive exactly.
const dir = join(path, ".."), graph = join(dir, "graph.db"), tagging = join(dir, "entityTagging.db");
const g = new DatabaseSync(graph);
for (const tb of ["stable_graph", "event_graph"]) g.exec(`CREATE TABLE ${tb} (subject INTEGER, predicate TEXT, relationshipId INTEGER, relationshipPredicate TEXT, object TEXT)`);
const ME = 9000000000000000001n, ANNA = 9000000000000000002n, ACME = 9000000000000000003n, CARL = 9000000000000000004n, ME2 = 9000000000000000005n, MEET = 9000000000000000006n;
const st = g.prepare("INSERT INTO stable_graph VALUES (?, ?, ?, ?, ?)"), evr = g.prepare("INSERT INTO event_graph VALUES (?, ?, ?, ?, ?)");
st.run(ME, "nm_isCurrentUser", 0, "", "true"); st.run(ME, "PS33", 0, "", "Ben Mateev");
st.run(ME2, "PS33", 0, "", "BEN [Old Job] MATEEV"); // an old card of the owner
st.run(ANNA, "PS33", 0, "", "Anna"); st.run(ACME, "PS33", 0, "", "Acme"); st.run(CARL, "PS33", 0, "", "Carl Stranger");
st.run(ANNA, "PS500", 7, "PS45", `md:${ACME}`);
evr.run(MEET, "PS33", 0, "", "Planning");
evr.run(MEET, "nm_hasDate", 8, "nm_imputedStartTime", String(now + day));
for (const [k, who] of [[9, ANNA], [10, CARL], [11, ME]]) evr.run(MEET, "PS232", k, "PS143", `md:${who}`);
g.close();
const tg = new DatabaseSync(tagging);
tg.exec("CREATE TABLE entity_tagging (mdid TEXT, family REAL, friend REAL, mother REAL, sister REAL)");
const tr = tg.prepare("INSERT INTO entity_tagging VALUES (?, ?, ?, ?, ?)");
tr.run(String(ANNA), .9, .1, .7, .1); tr.run(String(ME2), .96, 0, 0, 0); tr.run(String(CARL), .2, .9, 0, 0);
tg.close();
const P = { log: path, graph, tagging };

const rows = people(path);
assert.ok(!rows.some((r) => r.name === "Besties"), "group chats are not people");
assert.ok(!rows.some((r) => r.name === "Bob"), "3-person threads are not 1:1");
assert.equal(rows.find((r) => r.name === "Anna").total, 31);
assert.equal(rows.find((r) => r.name === "Anna").apps, "Phone, WhatsApp");
assert.ok(rows.some((r) => r.name === "unsaved number +49 ••• 567"), "numbers are masked");
assert.equal(mask("jane@example.com"), "unsaved email j•••@example.com");
assert.equal(mask("~ Lotte"), "Lotte (WhatsApp name, not in your contacts)");

assert.equal(people(P).find((r) => r.name === "Anna").employer, "Acme", "employer joined from the graph");
const ms = meetings(P, 7);
assert.equal(ms.length, 1); assert.equal(ms[0].title, "Planning");
assert.deepEqual(ms[0].attendees.map((r) => r.name).sort(), ["Anna", "Carl Stranger"], "owner is not an attendee");
const fam = circle(P, 0.5);
assert.deepEqual(fam.map((r) => r.name), ["Anna"], "owner look-alikes and low scores are dropped");
assert.equal(fam[0].role[0], "mother");

const call = (name, args = {}) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, P).result.content[0].text;
assert.match(call("meeting_prep"), /Planning\n  - Anna \(Acme\): last .* via/);
assert.match(call("meeting_prep"), /Carl Stranger: no 1:1 messages/);
assert.match(call("inferred_family"), /Anna \(Acme\): family 90%, friend 10%, likely mother \(70%\)/);
assert.match(call("top_contacts").split("\n")[1], /^- Anna \(Acme\):/);
assert.match(call("drifting"), /Old Friend/);
assert.doesNotMatch(call("drifting"), /Anna/);
assert.match(call("last_contact", { name: "old" }), /Old Friend: last .* 25 recent|Old Friend: last .* \/ 25 total/);
assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
assert.equal(handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }).result.tools.length, 5);
const denied = handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "top_contacts" } }, "/nonexistent/view.db").result;
assert.ok(denied.isError && /Full Disk Access/.test(denied.content[0].text), "missing access explains the fix");
const oldMac = handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "inferred_family" } }, { ...P, tagging: path }).result;
assert.ok(oldMac.isError && /tested on macOS/.test(oldMac.content[0].text), "unknown store layout says so");
console.log("ok: all checks passed");
