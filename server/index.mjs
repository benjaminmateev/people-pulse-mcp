#!/usr/bin/env node
// people-pulse: an MCP server over the interaction log and knowledge graph macOS keeps for Siri.
// Read-only. Returns names, dates, counts, app names, employers, meeting titles and Apple's family
// guesses. Never message content (the log has none).
// Zero dependencies: Node's built-in SQLite and a hand-written stdio JSON-RPC loop.
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const VERSION = "0.2.0";
const APPLE_EPOCH = 978307200; // seconds from 1970 to 2001-01-01, Apple's clock start
const IP = join(homedir(), "Library/IntelligencePlatform");
export const DEFAULT_DB = join(IP, "Artifacts/siri/remembers/view.db");
export const DEFAULT_PATHS = { log: DEFAULT_DB, graph: join(IP, "graph.db"), tagging: join(IP, "Artifacts/entityTagging/entityTagging.db") };
const paths = (p) => (typeof p === "string" ? { ...DEFAULT_PATHS, log: p } : { ...DEFAULT_PATHS, ...p });
const open = (path) => new DatabaseSync(path, { readOnly: true }); // never write: system daemons own these files

const APPS = {
  "net.whatsapp.whatsapp": "WhatsApp", "com.apple.mobilesms": "iMessage", "com.apple.incallservice": "Phone",
  "ph.telegra.telegraph": "Telegram", "org.whispersystems.signal": "Signal", "com.burbn.instagram": "Instagram",
  "com.apple.facetime": "FaceTime", "com.linkedin.linkedin": "LinkedIn", "com.tinyspeck.chatlyio": "Slack",
  "com.microsoft.skype.teams": "Teams", "com.facebook.messenger": "Messenger", "jp.naver.line": "LINE",
};
const appName = (b) => APPS[b.toLowerCase()] ?? b.split(".").pop();

// One row per person: 1:1 interactions only. "1:1" = the interaction names at most two people
// (them, and maybe you). WhatsApp also reports group chats as "people"; real people have a
// phone or email handle, groups don't, so names without one are dropped.
const SQL = `
WITH per AS (
  SELECT ie.interactionRowid irow, COUNT(*) people
  FROM interactionEntities ie JOIN entities e ON e.rowid = ie.entityRowid
  WHERE e.type = 'Person' GROUP BY 1),
real AS (
  SELECT DISTINCT json_extract(fields, '$.name') name FROM entities
  WHERE type = 'PersonHandle' AND json_extract(fields, '$.type') IS NOT NULL),
pi AS (
  SELECT DISTINCT json_extract(e.fields, '$.name') name, i.rowid irow
  FROM entities e
  JOIN interactionEntities ie ON ie.entityRowid = e.rowid
  JOIN interactions i ON i.rowid = ie.interactionRowid
  JOIN per ON per.irow = i.rowid
  WHERE e.type = 'Person' AND per.people <= 2 AND i.domain IN ('Messages', 'Calls')
    AND json_extract(e.fields, '$.name') IN (SELECT name FROM real))
SELECT pi.name name, COUNT(*) total, SUM(i.startDate > ?) recent,
       MAX(i.startDate) last, MIN(i.startDate) first, group_concat(DISTINCT i.bundleId) apps
FROM pi JOIN interactions i ON i.rowid = pi.irow
GROUP BY pi.name`;

// Phone numbers and emails of people not in your contacts are masked before they reach the AI.
export function mask(name) {
  const n = name.trim();
  if (/^[+\d(][\d\s()+-]{5,}$/.test(n)) {
    const d = n.replace(/\D/g, "");
    return `unsaved number ${n.startsWith("+") ? "+" + d.slice(0, 2) : d.slice(0, 2)} ••• ${d.slice(-3)}`;
  }
  if (/^\S+@\S+$/.test(n)) return `unsaved email ${n[0]}•••@${n.split("@")[1]}`;
  if (n.startsWith("~")) return `${n.slice(1).trim()} (WhatsApp name, not in your contacts)`;
  return n;
}

// The knowledge graph (graph.db) is a triple store. Names are PS33; a person's employer is a
// reified PS500 statement whose PS45 facet points at the company entity ("md:<id>").
const NAMES = "SELECT object FROM stable_graph WHERE subject = ? AND predicate = 'PS33' AND relationshipId = 0";
const EMPLOYERS = `
SELECT n.object name, (SELECT object FROM stable_graph WHERE subject = CAST(substr(e.object, 4) AS INTEGER)
  AND predicate = 'PS33' AND relationshipId = 0 ORDER BY length(object) DESC LIMIT 1) org
FROM stable_graph e JOIN stable_graph n ON n.subject = e.subject AND n.predicate = 'PS33' AND n.relationshipId = 0
WHERE e.predicate = 'PS500' AND e.relationshipPredicate = 'PS45'`;

// Employers are a bonus: if the graph can't be read, answers just come without them.
export function employers(graphPath) {
  try {
    const db = open(graphPath);
    try { return new Map(db.prepare(EMPLOYERS).all().filter((r) => r.org).map((r) => [r.name.toLowerCase(), r.org])); }
    finally { db.close(); }
  } catch { return new Map(); }
}

export function people(p = DEFAULT_PATHS, recentDays = 90, now = Date.now() / 1000) {
  const { log, graph } = paths(p), emp = employers(graph);
  const db = open(log);
  try {
    const since = now - APPLE_EPOCH - recentDays * 86400;
    return db.prepare(SQL).all(since).map((r) => ({
      name: mask(r.name), raw: r.name.toLowerCase(), employer: emp.get(r.name.toLowerCase()),
      total: r.total, recent: r.recent ?? 0,
      last: new Date((r.last + APPLE_EPOCH) * 1000).toISOString().slice(0, 10),
      daysSilent: Math.floor((now - r.last - APPLE_EPOCH) / 86400),
      apps: [...new Set(r.apps.split(",").map(appName))].sort().join(", "),
    }));
  } finally { db.close(); }
}

const who = (r) => r.employer ? `${r.name} (${r.employer})` : r.name;
const line = (r) => `- ${who(r)}: last ${r.last} (${r.daysSilent} days ago), ${r.recent} recent / ${r.total} total, via ${r.apps}`;
const int = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== null && v !== "" ? Math.round(+v) : d));

// Upcoming meetings: the graph keeps its own copy of the calendar. Start time is a reified
// nm_hasDate statement (nm_imputedStartTime, Apple seconds); attendees and organizer are PS232 / PS578
// statements whose PS143 facet points at a person entity. The owner is the entity marked nm_isCurrentUser.
const MEETINGS = `
WITH ev AS (
  SELECT DISTINCT subject eid, CAST(object AS REAL) ts FROM event_graph
  WHERE predicate = 'nm_hasDate' AND relationshipPredicate = 'nm_imputedStartTime' AND CAST(object AS REAL) BETWEEN ? AND ?)
SELECT CAST(ev.eid AS TEXT) eid, ev.ts, (SELECT object FROM event_graph WHERE subject = ev.eid AND predicate = 'PS33' LIMIT 1) title,
       group_concat(DISTINCT CAST(substr(a.object, 4) AS INTEGER)) pids
FROM ev JOIN event_graph a ON a.subject = ev.eid AND a.predicate IN ('PS232', 'PS578') AND a.relationshipPredicate = 'PS143'
WHERE CAST(substr(a.object, 4) AS INTEGER) NOT IN (SELECT subject FROM stable_graph WHERE predicate = 'nm_isCurrentUser')
GROUP BY ev.eid ORDER BY ev.ts`;

const when = (appleTs) => new Date((appleTs + APPLE_EPOCH) * 1000).toLocaleString("en-GB",
  { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function meetings(p = DEFAULT_PATHS, days = 7, now = Date.now() / 1000) {
  const P = paths(p), byName = new Map(people(P, 90, now).map((r) => [r.raw, r]));
  const emp = employers(P.graph), db = open(P.graph);
  try {
    const names = db.prepare(NAMES), from = now - APPLE_EPOCH, seen = new Set(), out = [];
    for (const m of db.prepare(MEETINGS).all(from, from + days * 86400)) {
      const key = `${m.ts}|${m.title}`; if (seen.has(key)) continue; seen.add(key); // same event, two calendars
      const attendees = String(m.pids).split(",").map((pid) => {
        const all = names.all(BigInt(pid)).map((r) => r.object); // ids exceed 2^53: keep them exact
        if (!all.length) return null;
        const hit = all.map((n) => byName.get(n.toLowerCase())).find(Boolean);
        const name = all.sort((a, b) => b.length - a.length)[0];
        return hit ?? { name: mask(name), employer: all.map((n) => emp.get(n.toLowerCase())).find(Boolean) };
      }).filter(Boolean);
      if (attendees.length) out.push({ when: when(m.ts), title: m.title ?? "(no title)", attendees });
    }
    return out;
  } finally { db.close(); }
}

// Apple's guesses about who is family or a friend: one row per graph entity in entityTagging.db,
// scores 0..1 from on-device models. Column sets vary by macOS version, so only read what exists.
const ROLES = ["mother", "father", "sister", "brother", "partner", "son", "daughter"];
export function circle(p = DEFAULT_PATHS, minScore = 0.5, now = Date.now() / 1000) {
  const P = paths(p), byName = new Map(people(P, 90, now).map((r) => [r.raw, r]));
  const tag = open(P.tagging), g = open(P.graph);
  try {
    const cols = new Set(tag.prepare("SELECT name FROM pragma_table_info('entity_tagging')").all().map((r) => r.name));
    if (!cols.has("family")) throw new Error("no such column: entity_tagging.family");
    const roles = ROLES.filter((c) => cols.has(c)), pick = ["family", "friend", ...roles].filter((c) => cols.has(c));
    const owner = new Set(g.prepare("SELECT CAST(subject AS TEXT) s FROM stable_graph WHERE predicate = 'nm_isCurrentUser'").all().map((r) => r.s));
    const names = g.prepare(NAMES), emp = employers(P.graph);
    // The owner often exists more than once (old work cards, "BENJAMEN MATEEV"): drop look-alikes of their name.
    const sig = (n) => { const w = n.toLowerCase().replace(/\[.*?\]|\(.*?\)/g, " ").match(/\p{L}+/gu) ?? []; return w.length > 1 ? w[0].slice(0, 4) + " " + w.at(-1) : null; };
    const me = new Set([...owner].flatMap((id) => names.all(BigInt(id)).map((r) => sig(r.object))).filter(Boolean));
    return tag.prepare(`SELECT CAST(mdid AS TEXT) id, ${pick.join(", ")} FROM entity_tagging WHERE family >= ? ORDER BY family DESC`).all(minScore)
      .filter((r) => !owner.has(r.id)).map((r) => {
        const all = names.all(BigInt(r.id)).map((x) => x.object);
        if (!all.length || all.some((n) => me.has(sig(n)))) return null;
        const hit = all.map((n) => byName.get(n.toLowerCase())).find(Boolean);
        const role = roles.map((c) => [c, r[c] ?? 0]).sort((a, b) => b[1] - a[1])[0];
        return { ...(hit ?? { name: mask(all.sort((a, b) => b.length - a.length)[0]), employer: all.map((n) => emp.get(n.toLowerCase())).find(Boolean) }),
          family: r.family, friend: r.friend ?? 0, role: role && role[1] >= 0.5 ? role : null };
      }).filter(Boolean);
  } finally { tag.close(); g.close(); }
}

const pct = (x) => `${Math.round(x * 100)}%`;
const brief = (r) => r.last ? `last ${r.last} (${r.daysSilent} days ago) via ${r.apps}` : "no 1:1 messages or calls on record";

export const TOOLS = [
  {
    name: "top_contacts",
    description: "Who you talk to most, one to one, across WhatsApp, iMessage, phone calls, Telegram, Signal, FaceTime and other apps, ranked by interactions in the last N days. Counts only, no message content.",
    inputSchema: { type: "object", properties: {
      days: { type: "integer", description: "Look-back window in days (default 90)", minimum: 1, maximum: 730 },
      limit: { type: "integer", description: "How many people (default 15)", minimum: 1, maximum: 100 } } },
    run: (a, p) => {
      const days = int(a.days, 90, 1, 730), limit = int(a.limit, 15, 1, 100);
      const rs = people(p, days).filter((r) => r.recent > 0).sort((x, y) => y.recent - x.recent).slice(0, limit);
      return `Top ${rs.length} people by 1:1 interactions (messages and calls) in the last ${days} days:\n` + rs.map(line).join("\n");
    },
  },
  {
    name: "drifting",
    description: "People you used to talk to a lot but haven't heard from in a while: at least N 1:1 interactions overall, silent for more than N days. Good for 'who should I reach out to?'",
    inputSchema: { type: "object", properties: {
      silent_days: { type: "integer", description: "Silent for more than this many days (default 45)", minimum: 7, maximum: 730 },
      min_interactions: { type: "integer", description: "Minimum 1:1 interactions to count as someone you talked to a lot (default 20)", minimum: 2, maximum: 10000 },
      limit: { type: "integer", description: "How many people (default 15)", minimum: 1, maximum: 100 } } },
    run: (a, p) => {
      const silent = int(a.silent_days, 45, 7, 730), min = int(a.min_interactions, 20, 2, 10000), limit = int(a.limit, 15, 1, 100);
      const rs = people(p).filter((r) => r.total >= min && r.daysSilent > silent).sort((x, y) => y.total - x.total).slice(0, limit);
      return `${rs.length} people with ${min}+ interactions, silent for more than ${silent} days, closest first:\n` + rs.map(line).join("\n");
    },
  },
  {
    name: "last_contact",
    description: "When you last talked to one person, how often overall, and on which apps. Matches part of a name.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { type: "string", description: "Full or partial name" } } },
    run: (a, p) => {
      const q = String(a.name ?? "").trim().toLowerCase();
      if (!q) return "Give me a name to look up.";
      const rs = people(p).filter((r) => r.name.toLowerCase().includes(q)).sort((x, y) => y.total - x.total).slice(0, 10);
      return rs.length ? rs.map(line).join("\n") : `No 1:1 conversations found for "${a.name}". The name has to match how it's saved in your contacts.`;
    },
  },
  {
    name: "meeting_prep",
    description: "Upcoming meetings in the next N days, with each attendee's employer and when you last messaged or called them, on which app. Uses the copy of your calendar in Apple's knowledge graph, which only has attendees for some meetings and can lag behind your calendar.",
    inputSchema: { type: "object", properties: {
      days: { type: "integer", description: "How many days ahead (default 7)", minimum: 1, maximum: 30 } } },
    run: (a, p) => {
      const days = int(a.days, 7, 1, 30), ms = meetings(p, days);
      if (!ms.length) return `No upcoming meetings with known attendees in the next ${days} days. Apple's graph only keeps attendees for some calendar events.`;
      return `${ms.length} meetings in the next ${days} days with people your Mac knows:\n` +
        ms.map((m) => `${m.when} · ${m.title}\n` + m.attendees.map((r) => `  - ${who(r)}: ${brief(r)}`).join("\n")).join("\n");
    },
  },
  {
    name: "inferred_family",
    description: "Who Apple's on-device models think is your family or close friends, with their scores (0 to 100%) and, when one reaches 50%, the role they guessed (mother, sister, partner...). These are machine guesses, not facts.",
    inputSchema: { type: "object", properties: {
      min_score: { type: "number", description: "Minimum family score, 0 to 1 (default 0.5)", minimum: 0, maximum: 1 },
      limit: { type: "integer", description: "How many people (default 20)", minimum: 1, maximum: 100 } } },
    run: (a, p) => {
      const min = Math.min(1, Math.max(0, Number.isFinite(+a.min_score) && a.min_score !== null && a.min_score !== "" ? +a.min_score : 0.5));
      const rs = circle(p, min).slice(0, int(a.limit, 20, 1, 100));
      if (!rs.length) return `Apple's models scored nobody at ${pct(min)} or more as family on this Mac.`;
      return `Apple's guesses: ${rs.length} people scored ${pct(min)}+ as family (machine guesses, not facts):\n` +
        rs.map((r) => `- ${who(r)}: family ${pct(r.family)}, friend ${pct(r.friend)}${r.role ? `, likely ${r.role[0]} (${pct(r.role[1])})` : ""}. ${brief(r)}`).join("\n");
    },
  },
];

export const ACCESS_HELP = `I can't read the interaction log on this Mac. This almost always means Claude doesn't have Full Disk Access yet.

To fix it:
1. Open System Settings > Privacy & Security > Full Disk Access.
2. Turn on Claude (click + and add Claude from Applications if it isn't listed).
3. Quit Claude completely (Cmd+Q) and open it again.

people-pulse only reads. It never changes anything on your Mac.`;

export const VERSION_HELP = `This Mac stores Apple's graph in a layout People Pulse doesn't know yet. Apple changes it between macOS releases; it has been tested on macOS 26.6 to 27.0. The other tools may still work.`;

export function handle(msg, p = DEFAULT_PATHS) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification: no reply
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "people-pulse", version: VERSION },
        instructions: "Answers who the user talks to and who they are about to meet, from the interaction log and knowledge graph macOS keeps for Siri. Data is metadata only (names, dates, counts, apps, employers, meeting titles). Present people warmly and briefly; never speculate about why someone went quiet. Family scores are Apple's machine guesses: present them as guesses, never as facts about someone's relationships." });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
      try { return ok({ content: [{ type: "text", text: tool.run(params.arguments ?? {}, p) }] }); }
      catch (e) {
        const m = String(e?.message), denied = /unable to open|authoriz|permission|not permitted|SQLITE_CANTOPEN/i.test(m);
        const text = denied ? ACCESS_HELP : /no such (table|column)/i.test(m) ? VERSION_HELP : `people-pulse failed: ${m}`;
        return ok({ isError: true, content: [{ type: "text", text }] });
      }
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    if (!l.trim()) return;
    let reply;
    try { reply = handle(JSON.parse(l)); }
    catch { reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  });
}
