// 收件匣：列出 appHome()/data/inbox/files 的檔案，點一下用 macOS 預設 App 開啟。
// 只讀：不刪檔、不寫檔、不連網，檔名一律當文字顯示，exec 一律用參數陣列。
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, theme, watchFolder } from "herdr";
import {
  formatSize, isRegularFile, listCommand, openCommand, parseListing,
  statCommand, thumbSource,
} from "./lib.js";

const INBOX_DIR = appHome() + "/data/inbox/files";
const BADGE = { image: "Image", video: "Video", pdf: "PDF" };

function clockText(seconds) {
  const d = new Date(seconds * 1000);
  const two = (n) => `0${n}`.slice(-2);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export default class Inbox extends View {
  init(_props, cx) {
    this.items = [];
    this.error = null;
    this.loading = true;
    this.notice = null;
    cx.spawn(async (cx) => {
      const made = await exec("/bin/mkdir", ["-p", INBOX_DIR]).catch(() => null);
      if (!made || made.code !== 0) {
        this.loading = false;
        this.error = `Cannot create the inbox folder: ${INBOX_DIR}`;
        cx.notify();
        return;
      }
      await this.load(cx);
      for (;;) {
        try {
          await watchFolder(INBOX_DIR);
        } catch {
          this.error = "Cannot watch the inbox folder";
          cx.notify();
          return;
        }
        await this.load(cx);
      }
    });
  }

  async load(cx) {
    const listed = listCommand(INBOX_DIR);
    const result = await exec(listed.cmd, listed.args).catch(() => null);
    if (!result || result.code !== 0) {
      this.items = [];
      this.error = `Cannot read the inbox: ${INBOX_DIR}`;
    } else {
      this.items = parseListing(result.stdout, INBOX_DIR);
      this.error = null;
    }
    this.loading = false;
    cx.notify();
  }

  // 點一列：先確認還是收件匣裡的一般檔案，再交給 open。
  launch(item, cx) {
    cx.spawn(async (cx) => {
      const stat = statCommand(item.path);
      const checked = await exec(stat.cmd, stat.args).catch(() => null);
      const command = checked && checked.code === 0 && isRegularFile(checked.stdout)
        ? openCommand(item.path, INBOX_DIR)
        : null;
      if (!command) {
        this.notice = `Cannot open: ${item.name}`;
        cx.notify();
        return;
      }
      const opened = await exec(command.cmd, command.args).catch(() => null);
      this.notice = opened && opened.code === 0 ? null : `Cannot open: ${item.name}`;
      cx.notify();
    });
  }

  badge(item, t) {
    return h_flex()
      .w(40)
      .h(40)
      .flex_none()
      .items_center()
      .justify_center()
      .bg(t.raised)
      .child(div().text_size(11).text_color(t.dim).child(BADGE[item.kind] ?? "File"));
  }

  row(item, index, t) {
    const thumb = thumbSource(item);
    return h_flex()
      .id(`inbox-row-${index}`)
      .h(52)
      .flex_none()
      .px(10)
      .gap(10)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => this.launch(item, cx))
      .child(thumb ? image(thumb).w(40).h(40).flex_none() : this.badge(item, t))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().child(item.name))
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(`${formatSize(item.size)} · ${clockText(item.mtime)}`),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const rows = this.items.map((item, index) => this.row(item, index, t));
    return v_flex()
      .id("inbox")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Inbox"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${this.items.length} file${this.items.length === 1 ? "" : "s"}`)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .children(rows)
          .when(Boolean(this.notice), (el) => el.child(div().p(8).text_size(12).text_color(t.blocked).child(this.notice)))
          .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(12).text_color(t.blocked).child(this.error)))
          .when(!this.error && this.items.length === 0, (el) =>
            el
              .child(div().p(8).text_size(12).text_color(t.dim).child(this.loading ? "Loading…" : "The inbox is empty"))
              .child(div().px(8).text_size(11).text_color(t.muted).child(INBOX_DIR)),
          ),
      );
  }
}
