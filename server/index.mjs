#!/usr/bin/env node
// people-pulse: an MCP server over the interaction log macOS keeps for Siri.
// Read-only. Returns names, dates, counts and app names. Never message content (the log has none).
// Zero dependencies: Node's built-in SQLite and a hand-written stdio JSON-RPC loop.
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
const APPLE_EPOCH = 978307200; // seconds from 1970 to 2001-01-01, Apple's clock start
export const DEFAULT_DB = join(homedir(), "Library/IntelligencePlatform/Artifacts/siri/remembers/view.db");

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

export function people(dbPath = DEFAULT_DB, recentDays = 90, now = Date.now() / 1000) {
  const db = new DatabaseSync(dbPath, { readOnly: true }); // never write: a system daemon owns this file
  try {
    const since = now - APPLE_EPOCH - recentDays * 86400;
    return db.prepare(SQL).all(since).map((r) => ({
      name: mask(r.name), total: r.total, recent: r.recent ?? 0,
      last: new Date((r.last + APPLE_EPOCH) * 1000).toISOString().slice(0, 10),
      daysSilent: Math.floor((now - r.last - APPLE_EPOCH) / 86400),
      apps: [...new Set(r.apps.split(",").map(appName))].sort().join(", "),
    }));
  } finally { db.close(); }
}

const line = (r) => `- ${r.name}: last ${r.last} (${r.daysSilent} days ago), ${r.recent} recent / ${r.total} total, via ${r.apps}`;
const int = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== null && v !== "" ? Math.round(+v) : d));

export const TOOLS = [
  {
    name: "top_contacts",
    description: "Who you talk to most, one to one, across WhatsApp, iMessage, phone calls, Telegram, Signal, FaceTime and other apps, ranked by interactions in the last N days. Counts only, no message content.",
    inputSchema: { type: "object", properties: {
      days: { type: "integer", description: "Look-back window in days (default 90)", minimum: 1, maximum: 730 },
      limit: { type: "integer", description: "How many people (default 15)", minimum: 1, maximum: 100 } } },
    run: (a, db) => {
      const days = int(a.days, 90, 1, 730), limit = int(a.limit, 15, 1, 100);
      const rs = people(db, days).filter((r) => r.recent > 0).sort((x, y) => y.recent - x.recent).slice(0, limit);
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
    run: (a, db) => {
      const silent = int(a.silent_days, 45, 7, 730), min = int(a.min_interactions, 20, 2, 10000), limit = int(a.limit, 15, 1, 100);
      const rs = people(db).filter((r) => r.total >= min && r.daysSilent > silent).sort((x, y) => y.total - x.total).slice(0, limit);
      return `${rs.length} people with ${min}+ interactions, silent for more than ${silent} days, closest first:\n` + rs.map(line).join("\n");
    },
  },
  {
    name: "last_contact",
    description: "When you last talked to one person, how often overall, and on which apps. Matches part of a name.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { type: "string", description: "Full or partial name" } } },
    run: (a, db) => {
      const q = String(a.name ?? "").trim().toLowerCase();
      if (!q) return "Give me a name to look up.";
      const rs = people(db).filter((r) => r.name.toLowerCase().includes(q)).sort((x, y) => y.total - x.total).slice(0, 10);
      return rs.length ? rs.map(line).join("\n") : `No 1:1 conversations found for "${a.name}". The name has to match how it's saved in your contacts.`;
    },
  },
];

export const ACCESS_HELP = `I can't read the interaction log on this Mac. This almost always means Claude doesn't have Full Disk Access yet.

To fix it:
1. Open System Settings > Privacy & Security > Full Disk Access.
2. Turn on Claude (click + and add Claude from Applications if it isn't listed).
3. Quit Claude completely (Cmd+Q) and open it again.

people-pulse only reads. It never changes anything on your Mac.`;

export function handle(msg, db = DEFAULT_DB) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification: no reply
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "people-pulse", version: VERSION },
        instructions: "Answers who the user talks to, from the interaction log macOS keeps for Siri. Data is metadata only (names, dates, counts, apps). Present people warmly and briefly; never speculate about why someone went quiet." });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
      try { return ok({ content: [{ type: "text", text: tool.run(params.arguments ?? {}, db) }] }); }
      catch (e) {
        const denied = /unable to open|authoriz|permission|not permitted|SQLITE_CANTOPEN|no such table/i.test(String(e?.message));
        return ok({ isError: true, content: [{ type: "text", text: denied ? ACCESS_HELP : `people-pulse failed: ${e?.message}` }] });
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
