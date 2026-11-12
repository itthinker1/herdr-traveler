// Pure helpers for the Herdr bridge. No mods API, no I/O: `claude plugin test`
// runs without files, processes or network, so everything here is testable.

const TASK_STATUS = new Set(["pending", "in_progress", "completed"]);

// A configured server name becomes the tool-name prefix Claude Code uses:
// "plugin:context7:context7" -> "plugin_context7_context7".
export function sanitizeServer(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

// "mcp__<server>__<tool>" -> { server, tool }. The split is at the first
// "__" after the prefix, which matches Claude Code's own naming.
export function splitMcpTool(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const at = rest.indexOf("__");
  if (at <= 0) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

// sources: [{ scope, servers: { [configuredName]: config } }]
// tools: ToolInfo[] from $.tool.list() — the only source of connection state.
export function inferMcpServers(sources, tools) {
  const configured = new Map();
  for (const src of sources ?? []) {
    for (const [name, config] of Object.entries(src?.servers ?? {})) {
      configured.set(name, { name, scope: src.scope ?? "unknown", config: config ?? {} });
    }
  }

  const counts = new Map();
  let toolTotal = 0;
  for (const tool of tools ?? []) {
    if (!tool || typeof tool.name !== "string") continue;
    if (!tool.mcp && !tool.name.startsWith("mcp__")) continue;
    const split = splitMcpTool(tool.name);
    if (!split) continue;
    counts.set(split.server, (counts.get(split.server) ?? 0) + 1);
    toolTotal += 1;
  }

  const seen = new Set();
  const servers = [];
  for (const entry of configured.values()) {
    const key = sanitizeServer(entry.name);
    const toolCount = counts.get(key) ?? 0;
    seen.add(key);
    servers.push({
      name: entry.name,
      scope: entry.scope,
      connected: toolCount > 0,
      toolCount,
    });
  }
  for (const [server, toolCount] of counts) {
    if (seen.has(server)) continue;
    servers.push({ name: server, scope: "runtime", connected: true, toolCount });
  }

  servers.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { servers, toolTotal };
}

// entries: [{ name: "1.json", text: "..." }]
export function parseTaskEntries(entries) {
  const items = [];
  for (const entry of entries ?? []) {
    const fileName = entry?.name ?? "";
    const match = /^(\d+)\.json$/.exec(fileName);
    if (!match) continue; // .lock, .highwatermark, notes.txt, ...
    let data;
    try {
      data = JSON.parse(entry.text);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || typeof data.subject !== "string") continue;
    items.push({
      id: String(data.id ?? match[1]),
      subject: data.subject,
      status: TASK_STATUS.has(data.status) ? data.status : "pending",
      activeForm: typeof data.activeForm === "string" ? data.activeForm : null,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
    });
  }
  items.sort((a, b) => Number(a.id) - Number(b.id));
  const counts = { pending: 0, in_progress: 0, completed: 0, total: items.length };
  for (const item of items) counts[item.status] += 1;
  return { items, counts };
}

// Old TodoWrite calls carry the whole list in the tool input. Convert them to
// the same shape as task files so the panel renders both alike.
export function todosToTasks(todos) {
  if (!Array.isArray(todos)) return null;
  const items = todos
    .filter((t) => t && typeof t.content === "string")
    .map((t, i) => ({
      id: String(i + 1),
      subject: t.content,
      status: TASK_STATUS.has(t.status) ? t.status : "pending",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : null,
      blocks: [],
      blockedBy: [],
    }));
  const counts = { pending: 0, in_progress: 0, completed: 0, total: items.length };
  for (const item of items) counts[item.status] += 1;
  return { items, counts };
}

export function parseSession(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!Number.isFinite(data.pid) || data.pid <= 0) return null;
  if (typeof data.sessionId !== "string" || data.sessionId === "") return null;
  return {
    pid: data.pid,
    sessionId: data.sessionId,
    cwd: typeof data.cwd === "string" ? data.cwd : null,
    version: typeof data.version === "string" ? data.version : null,
    name: typeof data.name === "string" ? data.name : null,
    status: typeof data.status === "string" ? data.status : null,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
  };
}

export function parseSnapshot(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.schema !== 1 || typeof data !== "object") return null;
  if (!Number.isFinite(data.pid) || data.pid <= 0) return null;
  return data;
}

// What changes count as real content changes. updatedAt/checkedAt are
// heartbeats and must not force a write.
export function stableKey(snapshot) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  delete copy.updatedAt;
  if (copy.mcp) delete copy.mcp.checkedAt;
  return JSON.stringify(copy);
}
