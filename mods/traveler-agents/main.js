// 旅人 Agents 卡片：把 agents() 畫成職業肖像卡片，HP/SP 讀 statusLine 寫的快取。
// 只讀快取檔、不跑指令、不連網、不讀對話紀錄與憑證，沒有數字就不畫數字。
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, readTextFile, run, setAgentOrder, spaces, theme, watchFolder } from "herdr";
import { appLabel, assignJobs, cachePath, fmtSize, gauge, jobIn, modelText, parseCache, portraitPath, remoteCachePath, spritePath, tabNames } from "./lib.js";

const HOME = appHome();
const SESSIONS_DIR = `${HOME}/data/traveler/sessions`;
const JOBS_FILE = `${HOME}/mods/traveler-agents/jobs.json`;
const PIC = 72;
// Full-body sprites are 36x48 pixels at 4x: 72x96 points, two pixels per point on Retina.
const SPRITE_W = 72;
const SPRITE_H = 96;
const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

// 肖像：配到職業就畫肖像圖；沒配到退回程式圖示（單色用 svg、圖片用 image），都沒有就留空。
function portrait(a, assigned, t) {
  const job = jobIn(a.tab_name, assigned);
  const sprite = spritePath(job, a.status);
  if (sprite) return image(sprite).w(SPRITE_W).h(SPRITE_H).flex_none();
  const src = portraitPath(job);
  if (src) return image(src).w(PIC).h(PIC).flex_none();
  const p = a.program;
  if (!p?.icon) return div().w(PIC).h(PIC).flex_none();
  return p.tint
    ? svg(p.icon).size(PIC).flex_none().text_color(t.foreground)
    : image(p.icon).w(PIC).h(PIC).flex_none();
}

// 一條 HP/SP 條：pct 為 null 就不填色、只顯示「—」；過舊的數字旁加「舊」並轉暗。
function bar(label, g, color, t) {
  return h_flex()
    .w_full()
    .min_w(0)
    .h(14)
    .gap(6)
    .items_center()
    .child(div().w(28).flex_none().text_size(10).text_color(t.dim).child(label))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .h(6)
        .bg(t.raised)
        .when(g.pct !== null, (el) => el.child(div().h_full().w(`${g.pct}%`).bg(color))),
    )
    .child(
      div()
        .flex_none()
        .text_size(11)
        .text_color(g.stale ? t.dim : t.foreground)
        .child(g.stale ? `${g.text} old` : g.text),
    );
}

// CTX 条按上下文「占用」分级变色（与 Claude Code 状态条一致）：<60% 绿（done）、60%~80% 黄（ansi3）、≥80% 红（blocked）；无数据返回 null 保持「—」。
function hpColor(pct, t) {
  if (pct === null) return null;
  if (pct < 60) return t.done;
  if (pct < 80) return t.ansi3;
  return t.blocked;
}

// Tag row: a small framed label, then "ctxSize · effort" (right-aligned, effort colored) when known.
function tag(label, left, effort, t) {
  const color = label.builder ? t.unknown : t.accent;
  return h_flex()
    .w_full()
    .min_w(0)
    .h(16)
    .gap(6)
    .items_center()
    .child(
      div()
        .flex_none()
        .px(5)
        .border(1)
        .border_color(color)
        .text_size(10)
        .text_color(color)
        .child(label.text),
    )
    .when(left !== null, (el) => el.child(effortLine(left, effort, t)));
}

// effort 配色与 Claude Code 状态栏（~/.claude/statusline.sh）一致：
// low→黄 ansi3、medium→绿 ansi2、high→蓝 ansi4、xhigh→紫 ansi5、max→红 ansi1、其它→dim。
function effortColor(effort, t) {
  if (effort === null) return t.dim;
  switch (effort) {
    case "low": return t.ansi3;
    case "medium": return t.ansi2;
    case "high": return t.ansi4;
    case "xhigh": return t.ansi5;
    case "max": return t.ansi1;
    default: return t.dim;
  }
}

// 上下文大小（dim，可截断）+「 · effort」（effort 按等级着色），整行居右。
function effortLine(left, effort, t) {
  return h_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .justify_end()
    .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(left))
    .when(effort !== null, (el) =>
      el
        .child(div().flex_none().text_size(11).text_color(t.dim).child(" · "))
        .child(div().flex_none().text_size(11).text_color(effortColor(effort, t)).child(effort)),
    );
}

function modelLine(model, t, align = "start") {
  return h_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .when(align === "end", (el) => el.justify_end())
    .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(model));
}

export default class Traveler extends View {
  init(_props, cx) {
    this.jobs = {};
    this.cache = {};
    this.remote = {};
    this.tick = 0;
    this.seen = new Set();
    this.watching = false;
    this.loadJobs(cx);
    this.load(cx);
    this.loadRemote(cx);
    this.watch(cx);
    // 資料是數字，最多 30 秒看一次就夠；也讓「舊」標記自己出現，順便重試監看。
    cx.timer.every(30000, (cx) => {
      this.load(cx);
      this.watch(cx);
      // 遠端每 60 秒讀一次，跟 statusLine 的更新間隔一樣；遠端資料夾不能監看。
      if (++this.tick % 2 === 0) this.loadRemote(cx);
    });
  }

  // 監看快取資料夾：有變更就重讀。資料夾不存在或不被允許時結束迴圈，
  // 交給上面的計時器每 30 秒重試，不會變成緊迴圈。
  watch(cx) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      let quick = 0;
      for (;;) {
        let changed;
        const started = Date.now();
        try {
          changed = await watchFolder(SESSIONS_DIR);
        } catch {
          break;
        }
        // 立刻回來又沒有任何變更，代表監看沒真的生效，也別讓它空轉。
        quick = Date.now() - started < 500 && (changed ?? []).length === 0 ? quick + 1 : 0;
        if (quick >= 3) break;
        this.load(cx);
      }
      this.watching = false;
    });
  }

  loadJobs(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(JOBS_FILE).catch(() => null);
      let jobs = {};
      try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) jobs = parsed;
      } catch {
        jobs = {};
      }
      this.jobs = jobs;
      cx.notify();
    });
  }

  // 每個本機 agent 讀自己那份快取；遠端的由 loadRemote 讀。
  load(cx) {
    const wanted = [];
    for (const a of agents()) {
      const path = cachePath(HOME, a.address);
      if (path === null) continue;
      this.seen.add(a.address);
      wanted.push({ address: a.address, path });
    }
    cx.spawn(async (cx) => {
      const next = {};
      for (const w of wanted) {
        const text = await readTextFile(w.path).catch(() => null);
        next[w.address] = parseCache(text);
      }
      this.cache = next;
      cx.notify();
    });
  }

  // 遠端 agent 讀它那台的快取檔（透過 Herdr 原有的連線，不執行指令）；連不上就是 null，畫面顯示「—」。
  loadRemote(cx) {
    const wanted = [];
    for (const a of agents()) {
      const r = remoteCachePath(a.address);
      if (r === null) continue;
      this.seen.add(a.address);
      wanted.push({ address: a.address, ...r });
    }
    if (wanted.length === 0) return;
    cx.spawn(async (cx) => {
      const next = {};
      for (const w of wanted) {
        const text = await readTextFile(w.path, { on: w.on }).catch(() => null);
        next[w.address] = parseCache(text);
      }
      this.remote = next;
      cx.notify();
    });
  }

  card(a, now, t) {
    const cache = this.cache[a.address] ?? this.remote[a.address] ?? null;
    const hp = gauge(cache ? cache.hp : null, cache ? cache.updatedAt : null, now);
    // blocked 一眼看得出來：框線與狀態文字都用 t.blocked，蓋過 focused 的 t.accent。
    const frame = a.status === "blocked" ? t.blocked : a.focused ? t.accent : t.border;
    const statusColor = a.status === "blocked" ? t.blocked : t[a.status] ?? t.dim;
    const label = appLabel(a.app);
    const modelName = cache?.model ?? null;
    const effort = cache?.effort ?? null;
    const tagLeft = fmtSize(cache?.size) ?? modelName;
    return h_flex()
      .id(`traveler-${a.address}`)
      .w_full()
      .flex_none()
      .p(8)
      .gap(10)
      .items_center()
      .bg(`${t.surface}c8`)
      .border(1)
      .border_color(frame)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(portrait(a, this.assigned, t))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(
            h_flex()
              .w_full()
              .min_w(0)
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().font_semibold().child(a.tab_name || a.address))
              .child(div().flex_none().text_size(11).text_color(statusColor).child(STATUS[a.status] ?? a.status)),
          )
          // Session name (set with /rename) under the tab name; takes no row when unset.
          .when(Boolean(cache?.name), (el) =>
            el.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.dim).child(cache.name)),
          )
          // Program tag: gold for Claude, purple for builders (orange means blocked).
          // Claude: context size · effort on the tag row. Builders: model on its own row, so long names fit.
          .when(Boolean(label), (el) => el.child(tag(label, label.builder ? null : tagLeft, label.builder ? null : effort, t)))
          .when(Boolean(label?.builder) && modelName !== null, (el) => el.child(h_flex().w_full().min_w(0).child(modelLine(modelName, t))))
          // Builders have no CTX source; Claude shows the CTX bar, then the model name where SP was.
          .when(!label?.builder, (el) =>
            el.child(bar("CTX", hp, hpColor(hp.pct, t), t))
              .when(modelName !== null, (el2) => el2.child(modelLine(modelName, t))),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const list = agents();
    this.assigned = assignJobs(tabNames(spaces(), list), this.jobs);
    setAgentOrder(list.map((a) => a.address));
    // 剛出現的 agent 先補讀一次快取，不用等下一次計時器。
    const fresh = list.filter((a) => !this.seen.has(a.address));
    if (fresh.some((a) => cachePath(HOME, a.address) !== null)) this.load(cx);
    if (fresh.some((a) => remoteCachePath(a.address) !== null)) this.loadRemote(cx);
    const now = Math.floor(Date.now() / 1000);
    return v_flex()
      .id("traveler")
      .size_full()
      .min_h(0)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(6)
          .p(6)
          .overflow_y_scrollbar()
          .children(list.map((a) => this.card(a, now, t)))
          .when(list.length === 0, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child("No agents")),
          ),
      );
  }
}
