# People Pulse

Ask Claude who you talk to most, and who you've drifted away from.

Your Mac already knows. For Siri, macOS keeps a private log of who you message and call: WhatsApp, iMessage, phone calls, Telegram, Signal, FaceTime and more, all in one place. People Pulse lets Claude read that log, on your Mac, and answer questions like:

- *"Who do I talk to the most these days?"*
- *"Who did I use to talk to a lot, but haven't in a while?"*
- *"When did I last speak to Anna?"*

No apps to connect, no accounts, no data to import. Install, give permission, ask.

Why I built this, and what else your Mac keeps about you: [The graph my Mac kept about me](https://benmateev.com/writing/the-graph-my-mac-kept/).

---

## What you need

- A Mac with a recent macOS (tested on macOS 26 and 27).
- The [Claude desktop app](https://claude.ai/download). People Pulse does not work in the browser or on your phone.
- About five minutes. You won't need the Terminal.

It works best if you use iMessage, WhatsApp or phone calls on an iPhone signed in with the same Apple ID as your Mac.

---

## Install in four steps

### 1. Download

Click here: **[Download People Pulse](https://github.com/benjaminmateev/people-pulse-mcp/releases/latest/download/people-pulse.mcpb)**

A file called `people-pulse.mcpb` lands in your Downloads folder.

### 2. Open it with Claude

Double-click `people-pulse.mcpb`. The Claude app opens and shows an install window. Click **Install**.

If double-clicking doesn't open Claude: open Claude, go to **Settings > Extensions**, and drag the file into that window.

### 3. Give Claude permission to read the log

The log is protected by macOS, so you have to allow it once.

1. Open **System Settings** (the gear icon in your Dock, or Apple menu  > System Settings).
2. Click **Privacy & Security** in the sidebar, then **Full Disk Access**.
3. Find **Claude** in the list and switch it on. If Claude isn't listed, click the **+** button at the bottom, open **Applications**, choose **Claude**, and click **Open**.
4. Your Mac may ask for your password. That's normal.

### 4. Restart Claude

Quit Claude completely: click Claude in the menu bar, then **Quit Claude** (or press **Cmd + Q**). Then open it again. The permission only takes effect after a restart.

That's it. Start a new chat and ask:

> Who do I talk to the most these days?

The first time, Claude asks whether it may use People Pulse. Click **Allow**.

---

## Good questions to try

- Who are my top 20 people over the last year?
- Who should I reach out to? People I used to talk to a lot but haven't in two months.
- When did I last talk to my brother, and how?
- Who do I mostly call instead of text?
- Make me a list of five people to message this week, and why.

---

## What it can see, and what it can't

**It sees:** names as they're saved in your contacts, the date of each message or call, how many there were, and which app was used.

**It never sees what you wrote or said.** The log macOS keeps doesn't contain message text, so there's nothing to read.

**It only reads.** People Pulse can't change, send or delete anything.

**Unsaved numbers are masked.** If you talk to a number that isn't in your contacts, Claude sees something like `unsaved number +49 ••• 628`, never the full number.

**What leaves your Mac.** People Pulse itself sends nothing anywhere. But when Claude uses it, the answer (names, dates, counts) becomes part of your chat, and your chats go to Anthropic like any other Claude conversation. If that's not OK for you, don't install it.

**About Full Disk Access.** This permission applies to the whole Claude app, not just People Pulse. It lets Claude's tools read protected files on your Mac. If you only want to try People Pulse once, you can switch the permission off again afterwards in the same place.

---

## If something doesn't work

**Claude says it can't read the log.** Claude doesn't have Full Disk Access yet, or wasn't restarted. Repeat steps 3 and 4. Quitting with Cmd + Q matters: closing the window isn't enough.

**The lists are short or empty.** The log only covers apps that report to your Mac, and only the last year or so. If you mostly use WhatsApp on Android, or messaging apps that don't report to macOS, there's little to show.

**Group chats are missing.** On purpose. People Pulse counts one-to-one conversations only, so a busy group chat doesn't make everyone in it look like a close friend.

**Someone shows up twice.** The same person can be saved twice in your contacts (for example once in iCloud and once in Gmail). Merging them in the Contacts app (Card > Look for Duplicates) fixes it.

---

## Remove it

In Claude, open **Settings > Extensions**, find People Pulse, and remove it. Then switch off Claude in **Full Disk Access** if you don't need it for anything else.

---

## For developers

One file, `server/index.mjs`, no dependencies. It uses Node's built-in SQLite and speaks MCP over stdio. It reads `~/Library/IntelligencePlatform/Artifacts/siri/remembers/view.db` read-only.

```sh
node test.mjs                                   # self-check against a fake log
claude mcp add people-pulse -- node "$PWD/server/index.mjs"   # use it in Claude Code
```

The process that runs it needs Full Disk Access (your terminal, for Claude Code). Build the extension with `npx @anthropic-ai/mcpb pack . people-pulse.mcpb`.

ChatGPT's desktop app doesn't run local servers like this one as far as I know, so it's Claude only for now.

## Credits

The map of where macOS keeps this data comes from [iKnow](https://github.com/8rank/iKnow) by Dario Pasquini and Michał Bazyli and their write-up, [Anatomy of Apple's Personal Knowledge Graph](https://8rank.ai/game/apple-intelligence-personal-knowledge-graph). People Pulse is not affiliated with Apple.

MIT licensed. Made by [Ben Mateev](https://benmateev.com).
