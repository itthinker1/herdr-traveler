// Herdr bridge: publishes the state the Herdr "claude-status" mod shows.
//
// It never touches the conversation. Every hook swallows its own errors so a
// broken bridge can't break a session, and every write is atomic (tmp + mv).
//
// Data source for MCP connection state is $.tool.list() only: a configured
// server with at least one `mcp__<server>__<tool>` tool is connected. Nothing
// here runs `claude mcp list` or reads MCP credentials.

import {
  inferMcpServers,
  parseSession,
  parseTaskEntries,
  stableKey,
  todosToTasks,
} from "./lib.js";

const BRIDGE_SUBDIR = ".claude/herdr-bridge";
const TICK_MS = 5000;
const CONFIG_MS = 60000;
const HEARTBEAT_MS = 30000;
const TASK_LIMIT = 200;

// Module-level state is shared by this module's hooks. Reloading the module
// resets it, and session.start re-initializes it.
let state = null;
let timer = null;

function freshState() {
  return {
    pid: null,
    home: null,
    bridgePath: null,
    sessionId: "",
    cwd: "",
    version: "",
    versionBase: null,
    builtAt: null,
    model: "",
    name: null,
    surface: null,
    interactive: false,
    startedAt: Date.now(),
    sources: null,
    sourcesAt: 0,
    lastTools: [],
    lastTodo: null,
    lastKey: "",
    lastWrite: 0,
    busy: false,
    queued: false,
  };
}

async function resolvePid($) {
  const r = await $.process.run(["sh", "-c", "echo $PPID"], { timeoutMs: 5000 });
  const pid = Number(String(r.stdout ?? "").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// If $PPID is a wrapper rather than Claude Code itself, find the session by
// its id in ~/.claude/sessions and take that file's pid.
async function findSession($, pid, sessionId) {
  if (pid) {
    const text = await $.fs
      .read(`${state.home}/.claude/sessions/${pid}.json`)
      .catch(() => null);
    const parsed = parseSession(text);
    if (parsed && (!sessionId || parsed.sessionId === sessionId)) {
      return { session: parsed, pid };
    }
  }
  if (!sessionId) return { session: null, pid };

  const list = await $.fs
    .list(`${state.home}/.claude/sessions`)
    .catch(() => []);
  for (const entry of list) {
    if (entry.kind !== "file" || !/^\d+\.json$/.test(entry.name)) continue;
    const text = await $.fs
      .read(`${state.home}/.claude/sessions/${entry.name}`)
      .catch(() => null);
    const parsed = parseSession(text);
    if (parsed && parsed.sessionId === sessionId) {
      return { session: parsed, pid: parsed.pid };
    }
  }
  return { session: null, pid };
}

async function init($, e) {
  const prevTodo = state?.lastTodo ?? null;
  state = freshState();
  state.lastTodo = prevTodo;
  state.startedAt = Date.now();

  const home =
    (await $.env.get("HOME").catch(() => undefined)) ||
    String((await $.process.run(["sh", "-c", 'printf %s "$HOME"'], { timeoutMs: 5000 })).stdout ?? "").trim();
  if (!home) return;
  state.home = home;

  await $.process.run(["mkdir", "-p", `${home}/${BRIDGE_SUBDIR}`], { timeoutMs: 5000 });

  const sessionId = (await $.session.id().catch(() => "")) || "";
  state.sessionId = sessionId;
  state.cwd = e.cwd || (await $.session.cwd().catch(() => "")) || "";
  state.surface = e.surface ?? null;
  state.interactive = e.isInteractive === true;

  const version = await $.session.version().catch(() => null);
  if (version && typeof version.version === "string") {
    state.version = version.version;
    state.versionBase = typeof version.base === "string" ? version.base : null;
    state.builtAt = typeof version.builtAt === "string" ? version.builtAt : null;
  }
  state.model = (await $.session.model().catch(() => "")) || "";

  const ppid = await resolvePid($).catch(() => null);
  const found = await findSession($, ppid, state.sessionId);
  state.pid = found.pid ?? ppid;
  state.name = found.session?.name ?? null;
  if (!state.sessionId && found.session) state.sessionId = found.session.sessionId;
  if (!state.cwd && found.session?.cwd) state.cwd = found.session.cwd;
  if (!state.version && found.session?.version) state.version = found.session.version;

  if (state.pid) state.bridgePath = `${home}/${BRIDGE_SUBDIR}/claude-${state.pid}.json`;
}

async function readConfigSources($) {
  const sources = [];

  const userText = await $.fs.read(`${state.home}/.claude.json`).catch(() => null);
  if (userText) {
    try {
      const data = JSON.parse(userText);
      if (data && data.mcpServers && typeof data.mcpServers === "object") {
        sources.push({ scope: "user", servers: data.mcpServers });
      }
      const local = data?.projects?.[state.cwd]?.mcpServers;
      if (local && typeof local === "object") {
        sources.push({ scope: "local", servers: local });
      }
    } catch {
      // A malformed config only loses the configured-name list.
    }
  }

  const projectText = await $.fs.read(`${state.cwd}/.mcp.json`).catch(() => null);
  if (projectText) {
    try {
      const data = JSON.parse(projectText);
      const servers = data?.mcpServers ?? data;
      if (servers && typeof servers === "object") {
        sources.push({ scope: "project", servers });
      }
    } catch {}
  }

  return sources;
}

async function readTasks($) {
  const entries = [];
  try {
    const dir = `${state.home}/.claude/tasks/${state.sessionId}`;
    const list = await $.fs.list(dir);
    const files = list
      .filter((f) => f.kind === "file" && /^\d+\.json$/.test(f.name))
      .slice(0, TASK_LIMIT);
    for (const file of files) {
      const text = await $.fs.read(`${dir}/${file.name}`).catch(() => null);
      if (text) entries.push({ name: file.name, text });
    }
  } catch {
    // No task directory: fall through to the TodoWrite fallback.
  }

  if (entries.length === 0 && state.lastTodo) {
    const converted = todosToTasks(state.lastTodo);
    if (converted) return converted;
  }
  return parseTaskEntries(entries);
}

async function collect($, force) {
  if (!state || !state.bridgePath) return null;
  const now = Date.now();

  if (force) {
    const sid = await $.session.id().catch(() => "");
    if (sid) state.sessionId = sid;
    const cwd = await $.session.cwd().catch(() => "");
    if (cwd && cwd !== state.cwd) {
      state.cwd = cwd;
      state.sourcesAt = 0;
    }
    const model = await $.session.model().catch(() => "");
    if (model) state.model = model;
    const version = await $.session.version().catch(() => null);
    if (version && typeof version.version === "string") {
      state.version = version.version;
      state.versionBase = typeof version.base === "string" ? version.base : null;
      state.builtAt = typeof version.builtAt === "string" ? version.builtAt : null;
    }
  }

  if (!state.sources || force || now - state.sourcesAt >= CONFIG_MS) {
    state.sources = await readConfigSources($);
    state.sourcesAt = now;
  }

  let tools = state.lastTools;
  let mcpError = null;
  try {
    tools = await $.tool.list();
    state.lastTools = tools;
  } catch {
    mcpError = "tool.list unavailable";
  }

  const mcp = inferMcpServers(state.sources ?? [], tools ?? []);
  mcp.checkedAt = now;
  mcp.error = mcpError;
  mcp.pending = mcp.toolTotal === 0 && now - state.startedAt < 10000;

  const tasks = await readTasks($);

  return {
    schema: 1,
    pid: state.pid,
    sessionId: state.sessionId,
    cwd: state.cwd,
    version: state.version,
    versionBase: state.versionBase,
    builtAt: state.builtAt,
    model: state.model,
    name: state.name,
    surface: state.surface,
    interactive: state.interactive,
    updatedAt: now,
    endedAt: null,
    endReason: null,
    mcp,
    tasks,
  };
}

async function publish($, force) {
  if (!state || !state.bridgePath) return;
  if (state.busy) {
    state.queued = true;
    return;
  }
  state.busy = true;
  try {
    const snapshot = await collect($, force);
    if (!snapshot) return;

    const key = stableKey(snapshot);
    const now = Date.now();
    if (!force && key === state.lastKey && now - state.lastWrite < HEARTBEAT_MS) return;

    const text = JSON.stringify(snapshot);
    const tmp = `${state.bridgePath}.tmp`;
    await $.fs.write(tmp, text);
    const moved = await $.process.run(
      ["/bin/mv", "-f", tmp, state.bridgePath],
      { timeoutMs: 5000 },
    );
    if (moved.exitCode !== 0) throw new Error(moved.stderr || "mv failed");

    state.lastKey = key;
    state.lastWrite = now;
  } catch {
    // Keep the previous bridge file. A failed publish is not a session error.
  } finally {
    state.busy = false;
    if (state.queued) {
      state.queued = false;
      void publish($, false);
    }
  }
}

async function markEnded($, reason, sessionId) {
  if (timer) {
    timer.cancel();
    timer = null;
  }
  if (!state || !state.bridgePath) return;
  try {
    const text = await $.fs.read(state.bridgePath).catch(() => null);
    const data = text
      ? JSON.parse(text)
      : { schema: 1, pid: state.pid, sessionId: sessionId ?? state.sessionId };
    data.endedAt = Date.now();
    data.endReason = reason ?? null;
    data.updatedAt = Date.now();

    const tmp = `${state.bridgePath}.tmp`;
    await $.fs.write(tmp, JSON.stringify(data));
    await $.process.run(["/bin/mv", "-f", tmp, state.bridgePath], { timeoutMs: 5000 });
  } catch {
    // The session is going away; a failed final write is acceptable.
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    try {
      if (timer) {
        timer.cancel();
        timer = null;
      }
      await init($, e);
      await publish($, true);
      timer = $.clock.every(TICK_MS, async () => {
        await publish($, false);
      });
    } catch {
      // Bridge-only failure; the session must start normally.
    }
    return next(e);
  });

  on("tool.call", { tool: ["TodoWrite", "TaskCreate", "TaskUpdate"] }, async ($, e, next) => {
    const result = await next(e);
    try {
      if (state) {
        if (e.tool === "TodoWrite" && Array.isArray(e.todos)) {
          state.lastTodo = e.todos;
        } else if (e.tool === "TaskCreate" || e.tool === "TaskUpdate") {
          state.lastTodo = null;
        }
      }
      await publish($, false);
    } catch {}
    return result;
  }).catch(async ($, e, next) => next(e));

  on("tool.call", { tool: /^mcp__/ }, async ($, e, next) => {
    const result = await next(e);
    try {
      await publish($, false);
    } catch {}
    return result;
  }).catch(async ($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    try {
      await publish($, true);
    } catch {}
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    try {
      await markEnded($, e.reason, e.sessionId);
    } catch {}
    return next(e);
  });
}
