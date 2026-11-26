// Self-check against a tiny fake interaction log. Run: node test.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { handle, mask, people, meetings, circle, contacts, findContacts } from "./server/index.mjs";

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
// Fake AddressBook: the main file plus one account under Sources/. Anna sits in both (must merge into one card).
const book = join(dir, "AddressBook"), abook = (file) => {
  mkdirSync(join(file, ".."), { recursive: true });
  const a = new DatabaseSync(file);
  a.exec(`CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZJOBTITLE TEXT, ZBIRTHDAY REAL, ZBIRTHDAYYEAR INTEGER);
CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
CREATE TABLE ZABCDNOTE (ZCONTACT INTEGER, ZTEXT TEXT);`);
  return a;
};
const card = (a, f, l, o = {}) => {
  const id = Number(a.prepare("INSERT INTO ZABCDRECORD (ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION, ZJOBTITLE, ZBIRTHDAY, ZBIRTHDAYYEAR) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(f, l, o.nick ?? null, o.org ?? null, o.title ?? null, o.bday ?? null, o.year ?? null).lastInsertRowid);
  for (const n of o.phones ?? []) a.prepare("INSERT INTO ZABCDPHONENUMBER VALUES (?, ?)").run(id, n);
  for (const m of o.mails ?? []) a.prepare("INSERT INTO ZABCDEMAILADDRESS VALUES (?, ?)").run(id, m);
  if (o.note) a.prepare("INSERT INTO ZABCDNOTE VALUES (?, ?)").run(id, o.note);
};
const main = abook(join(book, "AddressBook-v22.abcddb")), icloud = abook(join(book, "Sources", "ABC", "AddressBook-v22.abcddb"));
card(main, "Anna", "Muster", { org: "Acme GmbH", title: "CTO", phones: ["+49 176 1234567"], bday: 5 * 365.25 * day, year: 1990 }); // 1:1 log name "Anna" is matched below
card(icloud, "Anna", "Muster", { nick: "Annie", phones: ["0176 1234567", "+49 30 555 000"], mails: ["anna@acme.example"], note: "met at the fair" });
card(icloud, "Zed", "Nobody", { org: "Zed Corp", mails: ["zed@zed.example"], note: "x".repeat(300), bday: 100 * day });
card(icloud, null, null, {}); // empty card is ignored
card(icloud, "Lotte", "Lang", { org: "Lang AG" });
main.close(); icloud.close();
const P = { log: path, graph, tagging, contacts: book };

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

// Contacts: merged across sources, phone digits normalised, privacy-safe checks (counts and shapes only).
const all = contacts(book);
assert.equal(all.filter((c) => c.name === "Anna Muster").length, 1, "same person in two sources is one card");
const am = all.find((c) => c.name === "Anna Muster");
assert.equal(am.phones.length, 2, "same number written two ways is kept once");
assert.ok(am.company && am.title && am.nickname && am.emails.length === 1 && /^1990-/.test(am.birthday), "fields merged from both sources");
assert.ok(all.find((c) => c.name === "Zed Nobody").note === undefined, "long notes are dropped");
assert.match(all.find((c) => c.name === "Zed Nobody").birthday, /^--\d\d-\d\d$/, "birthday without a year");
assert.equal(all.length, 3, "empty cards are skipped");
const m1 = abook(join(dir, "Mixed", "AddressBook-v22.abcddb")), m2 = abook(join(dir, "Mixed", "Sources", "S", "AddressBook-v22.abcddb"));
card(m1, "Anna", "Muster", { phones: ["+49 888 1111111"] }); card(m2, "Anna", "Muster", { phones: ["+49 999 0000001"] });
card(m1, "Zed", "Nobody", { mails: ["zed@zed.example"] }); card(m2, "Zed", "Nobody", { mails: ["ZED@zed.example"] }); m1.close(); m2.close();
const mixed = contacts(join(dir, "Mixed"));
assert.equal(mixed.filter((c) => c.name === "Anna Muster").length, 2, "same name, no shared phone or email: two people");
assert.equal(mixed.filter((c) => c.name === "Zed Nobody").length, 1, "same name, shared email: merged");
assert.equal(findContacts("anna", 10, book).length, 1, "name match");
assert.equal(findContacts("annie", 10, book).length, 1, "nickname match");
assert.equal(findContacts("ZED CORP", 10, book).length, 1, "company match, any case");
assert.equal(findContacts("zed.example", 10, book).length, 1, "email match");
assert.equal(findContacts("+49 176 1234567", 10, book).length, 1, "+49 phone form");
assert.equal(findContacts("0176 1234567", 10, book).length, 1, "national phone form");
assert.equal(findContacts("0177 7654321", 10, book).length, 0, "a different number does not match");
assert.equal(findContacts("ann", 1, book).length, 1, "limit applies");
assert.equal(people(P).find((r) => r.name === "Anna").employer, "Acme", "graph employer wins over Contacts");
assert.throws(() => findContacts("x", 5, join(dir, "nowhere")), /unable to open/, "no address book is an access error");

const call = (name, args = {}) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, P).result.content[0].text;
const ct = call("find_contact", { query: "annie" });
assert.match(ct, /^1 contact found:\n- Anna Muster \| nickname Annie \| Acme GmbH \| CTO \| phone .* \| email .* \| birthday 1990-\d\d-\d\d$/);
assert.ok(!/note/.test(ct), "notes are off by default");
assert.match(call("find_contact", { query: "annie", include_notes: true }), /\| note: met/, "notes on request");
assert.match(call("find_contact", { query: "an" }), /at least 3 letters/, "short text query refused");
assert.match(call("find_contact", { query: "+49" }), /at least 3 letters or 4 digits/, "short phone query refused");
assert.match(call("find_contact", { query: "lang", limit: 999 }), /^1 contact/, "limit is clamped, not an error");
assert.equal(handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "find_contact", arguments: { query: "anna" } } }, path).result.content[0].text.startsWith("No contact"), true, "a string path never reads the real address book");
assert.match(call("find_contact", { query: "zzzzzz" }), /^No contact matches/);
assert.match(call("find_contact", { query: " " }), /Give me a name/);
assert.match(call("meeting_prep"), /Planning\n  - Anna \(Acme\): last .* via/);
assert.match(call("meeting_prep"), /Carl Stranger: no 1:1 messages/);
assert.match(call("inferred_family"), /Anna \(Acme\): family 90%, friend 10%, likely mother \(70%\)/);
assert.match(call("top_contacts").split("\n")[1], /^- Anna \(Acme\):/);
assert.match(call("drifting"), /Old Friend/);
assert.doesNotMatch(call("drifting"), /Anna/);
assert.match(call("last_contact", { name: "old" }), /Old Friend: last .* 25 recent|Old Friend: last .* \/ 25 total/);
assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
assert.equal(handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }).result.tools.length, 6);
const denied = handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "top_contacts" } }, "/nonexistent/view.db").result;
assert.ok(denied.isError && /Full Disk Access/.test(denied.content[0].text), "missing access explains the fix");
const oldMac = handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "inferred_family" } }, { ...P, tagging: path }).result;
assert.ok(oldMac.isError && /tested on macOS/.test(oldMac.content[0].text), "unknown store layout says so");
const noBook = handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "find_contact", arguments: { query: "xyz" } } }, { ...P, contacts: join(dir, "nowhere") }).result;
assert.ok(noBook.isError && /Full Disk Access/.test(noBook.content[0].text), "unreadable Contacts explains the fix");
console.log("ok: all checks passed");
