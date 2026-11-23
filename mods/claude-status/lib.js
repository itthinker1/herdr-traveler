// Pure parsing and formatting for the claude-status panel. No host calls.

export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
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

export function shortPath(path, home) {
  if (typeof path !== "string" || path === "") return "";
  if (typeof home === "string" && home !== "" && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

export function shortId(id) {
  return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id ?? "";
}

export function ago(ms, now) {
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function countTasks(tasks) {
  if (!tasks || !Array.isArray(tasks.items)) return { done: 0, total: 0 };
  return { done: tasks.counts?.completed ?? 0, total: tasks.items.length };
}

export function countMcp(mcp) {
  if (!mcp || !Array.isArray(mcp.servers)) return { connected: 0, total: 0 };
  return {
    connected: mcp.servers.filter((s) => s.connected).length,
    total: mcp.servers.length,
  };
}

export function taskState(task) {
  if (task.status === "completed") return "done";
  if (task.status === "in_progress") return "working";
  return "pending";
}

export function taskSubject(task) {
  if (task && typeof task.subject === "string") return task.subject;
  return "";
}

// The bridge's `agents` block, or nothing when the snapshot has none.
export function countAgents(agents) {
  const items = Array.isArray(agents?.items) ? agents.items : [];
  return {
    running: items.filter((agent) => agent?.status === "running").length,
    total: items.length,
  };
}

export function agentLabel(agent) {
  if (agent && typeof agent.name === "string" && agent.name !== "") return agent.name;
  if (agent && typeof agent.description === "string") return agent.description;
  return "";
}

// AgentStatus -> the same three shapes tasks use, plus "waiting".
export function agentState(agent) {
  const status = agent?.status;
  if (status === "running") return "working";
  if (status === "completed") return "done";
  if (status === "failed" || status === "killed") return "failed";
  return "waiting";
}

// The traveler statusline cache, shared with the left-hand agent cards. Both
// panels read it so they show the same model name instead of the bridge's raw
// model id ("Opus 5" rather than "claude-opus-5[1M]").
const SESSIONS_DIR = "data/traveler/sessions";
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A local terminal's cache file; remote addresses have no local file.
export function modelCachePath(appHomeDir, address) {
  if (typeof appHomeDir !== "string") return null;
  const base = appHomeDir.replace(/\/+$/, "");
  if (base === "") return null;
  if (typeof address !== "string" || !LOCAL_ID.test(address)) return null;
  return `${base}/${SESSIONS_DIR}/${address}.json`;
}

// A remote terminal's cache lives in that machine's own app home; read it over
// the connection Herdr already has.
export function remoteModelCachePath(address) {
  if (typeof address !== "string") return null;
  const parts = address.split("/");
  if (parts.length !== 2 || !MACHINE.test(parts[0]) || !LOCAL_ID.test(parts[1])) return null;
  return { on: parts[0], path: `.config/herdr-app/${SESSIONS_DIR}/${parts[1]}.json` };
}

// Only the fields the panel shows. A missing or malformed file is "no data".
export function parseModelCache(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const model = typeof data.model === "string" && data.model !== "" ? data.model : null;
  const effort = typeof data.effort === "string" && data.effort !== "" ? data.effort : null;
  const updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : null;
  if (model === null && effort === null) return null;
  return { model, effort, updatedAt };
}

// A sub-agent terminal's status: its own report when it has one, else the
// core's word. A sub-agent never shows "done" — it reports to its parent.
export function childStatus(agent, terminal) {
  const status = agent?.status ?? terminal?.status ?? null;
  if (status === "error") return "blocked";
  if (status === "done") return "idle";
  return status;
}

// The name a sub-agent terminal is known by: what it was named, then its
// template, program or address.
export function childName(terminal) {
  if (!terminal || typeof terminal !== "object") return "";
  for (const value of [terminal.name, terminal.template, terminal.program?.name, terminal.address]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}
