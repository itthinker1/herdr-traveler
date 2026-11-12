import { expect, test } from "claude-code/testing";
import {
  inferMcpServers,
  parseSnapshot,
  parseTaskEntries,
  sanitizeServer,
  splitMcpTool,
  stableKey,
  todosToTasks,
} from "../hooks/lib.js";

test("a configured server without tools is not connected", () => {
  const result = inferMcpServers(
    [{ scope: "user", servers: { codegraph: {} } }],
    [{ name: "Bash", description: "", mcp: false }],
  );
  expect(result.servers).toHaveLength(1);
  expect(result.servers[0]).toMatchObject({
    name: "codegraph",
    scope: "user",
    connected: false,
    toolCount: 0,
  });
  expect(result.toolTotal).toBe(0);
});

test("plugin server names map to their tool prefixes", () => {
  const result = inferMcpServers(
    [{ scope: "project", servers: { "plugin:context7:context7": {} } }],
    [
      {
        name: "mcp__plugin_context7_context7__query-docs",
        description: "",
        mcp: true,
      },
    ],
  );
  expect(result.servers[0]).toMatchObject({
    name: "plugin:context7:context7",
    connected: true,
    toolCount: 1,
  });
});

test("runtime-only servers are added and connected", () => {
  const result = inferMcpServers(
    [],
    [
      { name: "mcp__gitee__list_issues", description: "", mcp: true },
      { name: "mcp__tavily__search", description: "", mcp: true },
      { name: "mcp__tavily__extract", description: "", mcp: true },
    ],
  );
  expect(result.servers.map((s) => [s.name, s.toolCount])).toEqual([
    ["gitee", 1],
    ["tavily", 2],
  ]);
  expect(result.toolTotal).toBe(3);
});

test("sanitizeServer and splitMcpTool", () => {
  expect(sanitizeServer("plugin:context7:context7")).toBe("plugin_context7_context7");
  expect(sanitizeServer("my-server")).toBe("my_server");
  expect(splitMcpTool("mcp__gitee__list_issues")).toEqual({
    server: "gitee",
    tool: "list_issues",
  });
  expect(splitMcpTool("Bash")).toBeNull();
  expect(splitMcpTool("mcp__no-tool")).toBeNull();
});

test("tasks skip control files, bad JSON and sort numerically", () => {
  const result = parseTaskEntries([
    { name: "10.json", text: '{"id":"10","subject":"ten","status":"pending"}' },
    { name: "2.json", text: '{"id":"2","subject":"two","status":"in_progress"}' },
    { name: ".lock", text: "{}" },
    { name: ".highwatermark", text: "3" },
    { name: "notes.txt", text: "x" },
    { name: "3.json", text: "not json" },
    { name: "4.json", text: '{"id":"4","subject":"four","status":"completed"}' },
  ]);
  expect(result.items.map((i) => i.subject)).toEqual(["two", "four", "ten"]);
  expect(result.counts).toEqual({
    pending: 1,
    in_progress: 1,
    completed: 1,
    total: 3,
  });
});

test("TodoWrite lists convert to the task shape", () => {
  const result = todosToTasks([
    { content: "first", status: "completed", activeForm: "doing first" },
    { content: "second", status: "in_progress" },
  ]);
  expect(result.items.map((i) => [i.subject, i.status])).toEqual([
    ["first", "completed"],
    ["second", "in_progress"],
  ]);
  expect(result.counts.total).toBe(2);
});

test("stableKey ignores heartbeat timestamps", () => {
  const a = {
    schema: 1,
    pid: 1,
    updatedAt: 100,
    mcp: { servers: [], checkedAt: 100 },
  };
  const b = {
    schema: 1,
    pid: 1,
    updatedAt: 200,
    mcp: { servers: [], checkedAt: 200 },
  };
  expect(stableKey(a)).toBe(stableKey(b));
  expect(stableKey(a)).not.toBe(stableKey({ ...a, tasks: { items: [] } }));
});

test("parseSnapshot validates schema and pid", () => {
  expect(parseSnapshot('{"schema":1,"pid":7}')).toMatchObject({ pid: 7 });
  expect(parseSnapshot('{"pid":7}')).toBeNull();
  expect(parseSnapshot('{"schema":1,"pid":"7"}')).toBeNull();
  expect(parseSnapshot("not json")).toBeNull();
});
