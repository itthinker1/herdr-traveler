import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  exec,
  focused,
  hc,
  home,
  layout,
  panes,
  readTextFile,
  setShared,
  shared,
  theme,
  watchFolder,
} from "herdr";
import * as fs from "fs/promises";
import {
  ago,
  countMcp,
  countTasks,
  findNode,
  parseSession,
  parseSnapshot,
  shortId,
  shortPath,
  taskState,
  taskSubject,
} from "./lib.js";

const RECONCILE_MS = 250;
const RELOAD_MS = 60000;
const REFRESH_MS = 15000;

const STATUS_TEXT = {
  working: "Working",
  blocked: "Needs you",
  done: "Done",
  idle: "Idle",
};

export default class ClaudeStatus extends View {
  init(_props, cx) {
    this.home = home();
    this.bridgeDir = `${this.home}/.claude/herdr-bridge`;
    this.tasksDir = `${this.home}/.claude/tasks`;
    this.sessionsDir = `${this.home}/.claude/sessions`;

    this.targetAddr = null;
    this.targetStatus = null;
    this.targetCwd = null;
    this.targetBranch = null;
    this.data = null;
    this.error = null;
    this.loading = false;
    this.loadedAt = 0;
    this.gen = 0;
    this.watching = false;
    this.bridgeCount = 0;
    this.targetIsClaude = false;
    this.visibleFlag = null;

    // The traveler layout's tab bar only draws Files/Changes buttons when
    // workspace.panels lists them. Seed the default once; after that the
    // person's own choice is left alone.
    const panels = shared("workspace.panels");
    if (!shared("claude-status.panelsSeeded")) {
      setShared("claude-status.panelsSeeded", true);
      if (!Array.isArray(panels) || panels.length === 0) {
        setShared("workspace.panels", ["files", "changes"]);
      }
    }

    this.countBridge(cx);
    this.startWatch(cx);
    cx.timer.every(RECONCILE_MS, (cx) => this.reconcile(cx));
    cx.timer.every(REFRESH_MS, (cx) => {
      this.countBridge(cx);
      if (this.isVisible()) cx.notify();
    });
  }

  focusTarget() {
    const f = focused();
    if (!f) return null;

    let pane = f.pane ? panes().find((p) => p.pane === f.pane) ?? null : null;
    // The focused terminal is the truth; focused().agent stays on the last
    // agent even while a shell has the keyboard.
    let addr = f.terminal ?? pane?.terminal ?? f.agent ?? null;

    if (!addr) {
      const shown = panes().find((p) => p.focused && p.terminal);
      if (shown) {
        addr = shown.terminal;
        pane = shown;
      }
    }
    if (!addr) {
      const agent = agents().find((a) => a.focused);
      if (agent) addr = agent.address;
    }
    if (!addr) return null;

    const owner = panes().find((p) => p.terminal === addr) ?? pane;
    const agent = agents().find((a) => a.address === addr) ?? null;
    return { addr, pane: owner, agent };
  }

  // Follows the focused terminal. `render` also calls this: a focus change
  // re-renders the view, so the new target is picked up at once instead of
  // waiting for the poll interval.
  detect(cx) {
    if (!this.isVisible()) return false;

    const target = this.focusTarget();
    const addr = target?.addr ?? null;

    const changed = addr !== this.targetAddr;
    if (changed) {
      this.targetAddr = addr;
      this.data = null;
      this.error = null;
      this.loadedAt = 0;
      // Invalidate a load still running for the previous target, so it cannot
      // land its data after we have already moved on.
      this.gen += 1;
      this.loading = false;
    }
    this.targetStatus = target?.agent?.status ?? target?.pane?.status ?? null;
    this.targetCwd = target?.pane?.cwd ?? null;
    this.targetBranch = target?.pane?.branch ?? null;

    this.targetIsClaude =
      target?.pane?.app === "claude-code" || target?.agent?.app === "claude-code";

    return changed;
  }

  // True only while this block is actually on screen: the panel is shown and
  // its stack has the Claude tab active. A hidden panel or a different active
  // tab is a hidden copy, and does no work.
  isVisible() {
    const root = layout();
    const panel = findNode(root, "panel");
    if (panel?.hidden) return false;
    const body = findNode(root, "panel-body");
    return body?.active === "claude-status";
  }

  reconcile(cx) {
    if (!this.watching) this.startWatch(cx);

    const visible = this.isVisible();
    if (visible !== this.visibleFlag) {
      this.visibleFlag = visible;
      // Just shown: force a fresh read below instead of serving stale data.
      if (visible) this.loadedAt = 0;
    }
    if (!visible) return;

    const changed = this.detect(cx);
    // Redraw right away when the target moved, so a stale panel does not keep
    // showing the previous terminal while its data loads.
    if (changed) cx.notify();
    if (!this.targetAddr) return;

    // Reload only when the last check is old. A non-Claude focus leaves `data`
    // null, so "data === null" alone would retry `hc get` every tick.
    const stale = Date.now() - this.loadedAt > RELOAD_MS;
    if (stale) this.load(cx);
  }

  startWatch(cx) {
    if (this.watching) return;
    this.watching = true;
    const dir = this.bridgeDir;

    exec("mkdir", ["-p", dir]).catch(() => null);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(dir);
          if (!this.watching) return;
          this.countBridge(cx);
          if (this.isVisible() && this.targetAddr) this.load(cx);
        }
      } catch {
        this.watching = false;
      }
    });
  }

  countBridge(cx) {
    const dir = this.bridgeDir;
    cx.spawn(async (cx) => {
      let count = 0;
      try {
        const names = await fs.readdir(dir);
        count = names.filter((name) => /^claude-\d+\.json$/.test(name)).length;
      } catch {
        count = 0;
      }
      if (count !== this.bridgeCount) {
        this.bridgeCount = count;
        cx.notify();
      }
    });
  }

  load(cx) {
    const addr = this.targetAddr;
    if (!addr || this.loading) return;

    const gen = ++this.gen;
    this.loading = true;
    this.loadedAt = Date.now();

    cx.spawn(async (cx) => {
      let next = null;
      let error = null;

      try {
        const result = await hc(["get", addr, "--json"]);
        if (this.gen !== gen) return;

        let info = null;
        try {
          info = JSON.parse(result.stdout);
        } catch {
          info = null;
        }

        if (!info) {
          error = "Cannot read terminal";
        } else {
          const app = info?.status?.app ?? null;
          const foreground = info?.foreground ?? null;
          const argv0 = String(foreground?.argv?.[0] ?? "");
          const isClaude = app === "claude-code" || argv0.includes("claude");

          if (!isClaude) {
            error = "NOT_CLAUDE";
          } else if (!Number.isFinite(foreground?.pid)) {
            error = "NO_PID";
          } else {
            next = await this.readFor(cx, foreground.pid, foreground);
            if (this.gen !== gen) return;
          }
        }
      } catch (e) {
        error = String(e?.message ?? e);
      }

      if (this.gen !== gen) return;
      this.loading = false;
      this.error = error;
      this.data = error ? null : next;
      cx.notify();
    });
  }

  async readFor(cx, pid, foreground) {
    // The bridge plugin's snapshot, when a session has loaded it.
    const bridgeText = await readTextFile(
      `${this.bridgeDir}/claude-${pid}.json`,
    ).catch(() => null);
    const snapshot = parseSnapshot(bridgeText);
    if (snapshot) return { ...snapshot, kind: "bridge" };

    // Fallback: Claude Code writes its own per-process session record.
    const sessionText = await readTextFile(
      `${this.sessionsDir}/${pid}.json`,
    ).catch(() => null);
    const session = parseSession(sessionText);
    const tasks = session?.sessionId
      ? await this.readTasks(cx, session.sessionId)
      : null;

    return {
      kind: "fallback",
      pid,
      sessionId: session?.sessionId ?? null,
      cwd: session?.cwd ?? foreground?.cwd ?? null,
      version: session?.version ?? String(foreground?.name ?? ""),
      versionBase: null,
      model: "",
      name: session?.name ?? null,
      mcp: null,
      tasks,
      updatedAt: session?.updatedAt ?? Date.now(),
      endedAt: null,
    };
  }

  async readTasks(_cx, sessionId) {
    const dir = `${this.tasksDir}/${sessionId}`;
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      names = [];
    }

    const numeric = names
      .filter((name) => /^\d+\.json$/.test(name))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
      .slice(0, 50);

    const items = [];
    for (const name of numeric) {
      const text = await readTextFile(`${dir}/${name}`).catch(() => null);
      if (!text) continue;
      try {
        const task = JSON.parse(text);
        if (!task || typeof task.subject !== "string") continue;
        items.push({
          id: String(task.id ?? name.slice(0, -5)),
          subject: task.subject,
          status: task.status ?? "pending",
          activeForm: task.activeForm ?? null,
          blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
        });
      } catch {}
    }

    const counts = { pending: 0, in_progress: 0, completed: 0, total: items.length };
    for (const item of items) {
      if (item.status === "completed") counts.completed += 1;
      else if (item.status === "in_progress") counts.in_progress += 1;
      else counts.pending += 1;
    }
    return { items, counts };
  }

  render(cx) {
    const t = theme();
    this.detect(cx);
    const now = Date.now();
    const data = this.data;
    const version = data?.version || data?.versionBase || "";

    const program = this.targetIsClaude
      ? panes().find((p) => p.terminal === this.targetAddr)?.program ?? null
      : null;
    const icon = program?.icon
      ? program.tint
        ? svg(program.icon).size(16).flex_none().text_color(program.color ?? t.foreground)
        : image(program.icon).w(16).h(16).flex_none()
      : null;

    const status = this.targetIsClaude ? this.targetStatus : null;
    const statusColor = status ? t[status] ?? t.dim : t.dim;

    const header = h_flex()
      .id("claude-status-head")
      .h(38)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .when(Boolean(icon), (el) => el.child(icon))
      .child(div().font_semibold().text_color(t.foreground).child("Claude Code"))
      .when(Boolean(version), (el) => el.child(this.chip(version, t)))
      .child(h_flex().flex_1())
      .when(
        Boolean(status),
        (el) =>
          el
            .child(div().size(7).flex_none().rounded(4).bg(statusColor))
            .child(
              div()
                .text_size(11)
                .text_color(t.muted)
                .child(STATUS_TEXT[status] ?? status),
            ),
      )
      .when(
        Boolean(data?.endedAt),
        (el) =>
          el.child(
            div()
              .px(6)
              .h(18)
              .flex()
              .items_center()
              .rounded(5)
              .bg(t.raised)
              .text_size(10.5)
              .text_color(t.dim)
              .child("ended"),
          ),
      );

    const body = this.renderBody(t, now, data);

    return v_flex()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .child(header)
      .child(
        v_flex()
          .id("claude-status-body")
          .flex_1()
          .min_h(0)
          .p(12)
          .gap(16)
          .overflow_y_scrollbar()
          .mode("always")
          .children(body),
      );
  }

  renderBody(t, now, data) {
    // A shell or other non-Claude focus leaves the panel without data: say so
    // instead of showing a blank pane.
    if (!this.targetIsClaude || !data) {
      return [
        v_flex()
          .gap(4)
          .p(8)
          .rounded(6)
          .bg(t.raised)
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child("暂无信息"),
          ),
      ];
    }

    const sections = [];

    if (data.kind === "fallback") {
      sections.push(
        v_flex()
          .gap(4)
          .p(8)
          .rounded(6)
          .bg(t.raised)
          .child(
            div()
              .text_size(11)
              .font_semibold()
              .text_color(t.working)
              .child("桥接插件未加载"),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child("MCP 状态不可用。把 herdr-bridge 放进 ~/.claude/skills/ 并重启 Claude 会话。"),
          ),
      );
    }

    sections.push(this.sessionSection(t, now, data));

    // A divider between the SESSION / MCP / TASKS blocks.
    const divider = () => div().h(1).bg(t.border);

    sections.push(divider());

    if (data.mcp) {
      sections.push(this.mcpSection(t, data.mcp));
    } else {
      sections.push(
        this.section(
          t,
          "MCP",
          "",
          [
            div()
              .text_size(11)
              .text_color(t.dim)
              .child("暂无连接状态（需要桥接插件）"),
          ],
        ),
      );
    }

    sections.push(divider());

    sections.push(this.tasksSection(t, data.tasks));

    return sections;
  }

  sessionSection(t, now, data) {
    const rows = [];
    if (data.model) rows.push(this.infoRow(t, "Model", data.model));
    if (data.sessionId) rows.push(this.infoRow(t, "Session", shortId(data.sessionId)));
    if (data.cwd) rows.push(this.infoRow(t, "Folder", shortPath(data.cwd, this.home)));
    if (this.targetBranch) rows.push(this.infoRow(t, "Branch", this.targetBranch));
    rows.push(
      this.infoRow(
        t,
        data.kind === "bridge" ? "Updated" : "Seen",
        ago(data.updatedAt, now) + " ago",
      ),
    );

    return this.section(
      t,
      "SESSION",
      data.name ?? "",
      rows,
    );
  }

  mcpSection(t, mcp) {
    const counts = countMcp(mcp);
    const rows = [];

    if (mcp.pending) {
      rows.push(div().text_size(11).text_color(t.dim).child("starting…"));
    } else if (mcp.servers.length === 0) {
      rows.push(div().text_size(11).text_color(t.dim).child("没有 MCP 服务器"));
    } else {
      for (const server of mcp.servers) {
        const color = server.connected ? t.done : t.blocked;
        rows.push(
          h_flex()
            .h(26)
            .flex_none()
            .px(2)
            .gap(8)
            .items_center()
            .rounded(5)
            .hover((s) => s.bg(t.hover))
            .child(div().size(7).flex_none().rounded(4).bg(color))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(server.connected ? t.foreground : t.muted)
                .child(server.name),
            )
            .child(this.chip(server.scope ?? "", t))
            .child(
              div()
                .flex_none()
                .text_size(10.5)
                .text_color(server.connected ? t.dim : t.blocked)
                .child(server.connected ? `${server.toolCount} tools` : "no tools"),
            ),
        );
      }
    }

    if (mcp.error) {
      rows.push(div().text_size(10.5).text_color(t.blocked).child(mcp.error));
    }

    return this.section(
      t,
      "MCP",
      `${counts.connected}/${counts.total} connected`,
      rows,
    );
  }

  tasksSection(t, tasks) {
    const counts = countTasks(tasks);
    const rows = [];

    if (!tasks || tasks.items.length === 0) {
      rows.push(div().text_size(11).text_color(t.dim).child("没有任务"));
    } else {
      for (const task of tasks.items) {
        const state = taskState(task);
        const icon =
          state === "working"
            ? svg("mods/workspace-chrome/spinner.svg")
                .size(12)
                .flex_none()
                .text_color(t.working)
                .spin(900)
            : state === "done"
              ? div()
                  .size(14)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_size(11)
                  .text_color(t.done)
                  .child("✓")
              : div()
                  .size(7)
                  .flex_none()
                  .rounded(4)
                  .border(1.5)
                  .border_color(t.dim);

        rows.push(
          h_flex()
            .h(28)
            .flex_none()
            .px(2)
            .gap(8)
            .items_center()
            .when(
              Boolean(task.blockedBy && task.blockedBy.length),
              (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(4)
                    .h(16)
                    .flex()
                    .items_center()
                    .rounded(4)
                    .bg(t.blocked + "26")
                    .text_size(9.5)
                    .font_semibold()
                    .text_color(t.blocked)
                    .child("!"),
                ),
            )
            .child(icon)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(
                  state === "done" ? t.dim : state === "working" ? t.foreground : t.muted,
                )
                .child(taskSubject(task)),
            )
            .when(
              state === "working" && Boolean(task.activeForm),
              (el) =>
                el.child(
                  div()
                    .flex_none()
                    .text_size(10)
                    .text_color(t.dim)
                    .child(task.activeForm),
                ),
            ),
        );
      }
    }

    return this.section(t, "TASKS", `${counts.done}/${counts.total} done`, rows);
  }

  section(t, title, right, children) {
    return v_flex()
      .gap(4)
      .flex_none()
      .child(
        h_flex()
          .h(24)
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(12)
              .font_bold()
              .text_color(t.accent)
              .child(title),
          )
          .child(div().text_size(11).text_color(t.muted).child(right ?? "")),
      )
      .children(children);
  }

  infoRow(t, label, value) {
    return h_flex()
      .h(24)
      .flex_none()
      .gap(8)
      .items_center()
      .child(
        div()
          .w(64)
          .flex_none()
          .text_size(11)
          .text_color(t.dim)
          .child(label),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12)
          .text_color(t.foreground)
          .child(value),
      );
  }

  chip(text, t) {
    return div()
      .px(5)
      .h(16)
      .flex_none()
      .flex()
      .items_center()
      .rounded(4)
      .bg(t.raised)
      .text_size(9.5)
      .text_color(t.dim)
      .child(text);
  }

}
