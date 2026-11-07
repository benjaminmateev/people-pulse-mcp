// Self-check against a tiny fake interaction log. Run: node test.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { handle, mask, people } from "./server/index.mjs";

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

const rows = people(path);
assert.ok(!rows.some((r) => r.name === "Besties"), "group chats are not people");
assert.ok(!rows.some((r) => r.name === "Bob"), "3-person threads are not 1:1");
assert.equal(rows.find((r) => r.name === "Anna").total, 31);
assert.equal(rows.find((r) => r.name === "Anna").apps, "Phone, WhatsApp");
assert.ok(rows.some((r) => r.name === "unsaved number +49 ••• 567"), "numbers are masked");
assert.equal(mask("jane@example.com"), "unsaved email j•••@example.com");
assert.equal(mask("~ Lotte"), "Lotte (WhatsApp name, not in your contacts)");

const call = (name, args = {}) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, path).result.content[0].text;
assert.match(call("top_contacts").split("\n")[1], /^- Anna:/);
assert.match(call("drifting"), /Old Friend/);
assert.doesNotMatch(call("drifting"), /Anna/);
assert.match(call("last_contact", { name: "old" }), /Old Friend: last .* 25 recent|Old Friend: last .* \/ 25 total/);
assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
assert.equal(handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }).result.tools.length, 3);
const denied = handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "top_contacts" } }, "/nonexistent/view.db").result;
assert.ok(denied.isError && /Full Disk Access/.test(denied.content[0].text), "missing access explains the fix");
console.log("ok: all checks passed");
