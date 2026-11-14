# herdr-bridge

A minimal Claude Code mod that publishes what the Herdr `claude-status` panel
shows: Claude Code version/model, MCP server connection state, and tasks.
It deliberately does **not** publish context-window usage.

## Install

The plugin lives at `~/.claude/skills/herdr-bridge/`. Claude Code loads
plugins under `~/.claude/skills/` at startup (`herdr-bridge@skills-dir`), so
any new session picks it up. Sessions that were already running keep their
loaded plugin set: restart the session (or start a new one) to see data.

To load it for one session without the skills directory:

```sh
claude --plugin-dir ~/.claude/skills/herdr-bridge
```

To turn it off while keeping it installed, put `"herdr-bridge@skills-dir": false`
in `enabledPlugins` in a settings file.

## Data written

Every five seconds, and after tool calls and turns, the hooks module writes
`~/.claude/herdr-bridge/claude-<pid>.json` atomically (`.tmp` + `mv`). The
panel matches the focused Herdr terminal's `foreground.pid`, so multiple
Claude sessions in the same folder stay distinct.

Shape:

```json
{
  "schema": 1,
  "pid": 83349,
  "sessionId": "…",
  "cwd": "/Users/home/code/project",
  "version": "2.1.295",
  "model": "…",
  "updatedAt": 1794406161993,
  "endedAt": null,
  "mcp": {
    "servers": [{ "name": "gitee", "scope": "user", "connected": true, "toolCount": 25 }],
    "toolTotal": 57,
    "pending": false,
    "error": null
  },
  "tasks": {
    "items": [{ "id": "1", "subject": "…", "status": "in_progress", "blockedBy": [] }],
    "counts": { "pending": 0, "in_progress": 1, "completed": 0, "total": 1 }
  },
  "agents": {
    "items": [{ "id": "…", "name": null, "description": "…", "type": "general-purpose", "status": "running" }],
    "counts": { "running": 1, "total": 1 }
  }
}
```

`agents` comes from `$.agent.list()`: this session's subagents and teammates,
with the fields the panel draws (id, name, description, type, status) and
nothing else — no prompt, no transcript. A build or a session without the call
publishes an empty list, and a call that fails adds `error` with the reason.

No MCP credentials, environment variables, prompts or transcript content are
written.

## How MCP state is inferred

The only source is `$.tool.list()`. A server configured in user
(`~/.claude.json`), project (`.mcp.json`) or local scope with at least one
`mcp__<server>__<tool>` tool is shown as connected. A configured server with
zero tools shows as "no tools" — it may be disconnected, or it may simply
expose no tools. Servers that appear only at runtime (plugin-shipped or
claude.ai connectors) are listed as connected.

`claude mcp list` is never run: it costs a process and a health check each time.

## Limits

- Only sessions that loaded the plugin publish state. Without it, the Herdr
  panel falls back to `~/.claude/sessions/<pid>.json` for version/session and
  reads tasks directly, and shows MCP state as unavailable.
- `--safe-mode`, `--bare` and `disableAllHooks` keep the plugin from loading.
- macOS/Linux only (the atomic write uses `/bin/mv`).
- The bridge is local to the machine; Herdr's remote-machine terminals are not
  bridged.

## Verify

```sh
claude plugin validate ~/.claude/skills/herdr-bridge
cd ~/.claude/skills/herdr-bridge && claude plugin test
```
