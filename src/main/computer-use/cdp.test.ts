/**
 * CDP 通道的宿主侧这一层的账（main/computer-use/cdp.ts）。
 *
 * 真机行为（起 Edge、WS 拼帧、截图、上传下载落盘）只能由沙箱里的验收验——宿主上碰
 * msedge 是红线。这里用一个**假桥**测这一层独有的活：
 *   - 动作 → cdp-* 命令与字段（一次往返）；
 *   - 「没起过浏览器」时 navigate 自动 cdp-start，其余动作报「先 sandbox_navigate」；
 *   - 缓存自愈（命令报「没有在运行」→ 清缓存 + 重试一次，且只重试一次）；
 *   - 上传把文件拷进映射目录、下载把不可信文件名翻成宿主路径；
 *   - 失败文案带「可以退回像素工具」的降级指引（模型只有这句话能换道）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySandboxBrowserRequest, CdpSession, type CdpGuest } from "./cdp.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";
import {
  computerUseGuestCommands,
  type ComputerUseToolRequest,
} from "../../shared/computer-use.ts";

interface Call {
  command: string;
  fields: Record<string, unknown>;
}

type Reply = GuestCommandReply | GuestShotReply;

interface FakeOptions {
  /** 每条命令的回执（按命令名）。没给的走默认：status → running:false */
  replies?: Record<string, (fields: Record<string, unknown>, index: number) => Reply>;
  /** 默认 status 是否 running（未给 replies 时生效） */
  running?: boolean;
}

function fakeGuest(options: FakeOptions = {}): { guest: CdpGuest; calls: Call[] } {
  const calls: Call[] = [];
  const reply = (command: string, fields: Record<string, unknown>, index: number): Reply => {
    const custom = options.replies?.[command];
    if (custom !== undefined) return custom(fields, index);
    if (command === computerUseGuestCommands.cdpStatus) {
      return { ok: true, resp: { ok: true, running: options.running === true, port: 12345 } };
    }
    if (command === computerUseGuestCommands.cdpStart) {
      return { ok: true, resp: { ok: true, port: 12345, product: "Edg/154.0.4258.62" } };
    }
    return { ok: true, resp: { ok: true } };
  };
  const guest: CdpGuest = {
    async guestCommandReply(command, fields) {
      const index = calls.length;
      calls.push({ command, fields });
      return reply(command, fields, index) as Promise<GuestCommandReply> extends never ? never : GuestCommandReply;
    },
    async guestShot(command, fields) {
      const index = calls.length;
      calls.push({ command, fields });
      const custom = options.replies?.[command];
      if (custom !== undefined) return custom(fields, index) as GuestShotReply;
      return {
        ok: true,
        jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        resp: {
          ok: true,
          jpeg: "cmd-000001.jpg",
          width: 1000,
          height: 600,
          nativeWidth: 1366,
          nativeHeight: 820,
          url: "https://example.com/",
          title: "Example",
        },
      };
    },
  };
  return { guest, calls };
}

/** 每个 test 自己的临时映射目录（上传 / 下载的宿主侧落点） */
function tempOutDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "orbita-cdp-test-"));
}

const run = (cdp: CdpSession, request: ComputerUseToolRequest) => applySandboxBrowserRequest(cdp, request);

describe("CdpSession：动作 → cdp-* 命令", () => {
  test("navigate：先 cdp-status（没起）→ cdp-start → cdp-nav，回执带 URL 与「下一步 observe」", async () => {
    const { guest, calls } = fakeGuest({
      replies: {
        [computerUseGuestCommands.cdpNav]: () => ({
          ok: true,
          resp: { ok: true, url: "https://example.com/", title: "Example Domain", ms: 812 },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-navigate", url: "example.com" });

    assert.equal(outcome.ok, true);
    assert.deepEqual(
      calls.map((call) => call.command),
      [computerUseGuestCommands.cdpStatus, computerUseGuestCommands.cdpStart, computerUseGuestCommands.cdpNav],
    );
    assert.deepEqual(calls[2]?.fields, { url: "example.com" });
    assert.match(outcome.ok ? outcome.text : "", /https:\/\/example\.com\//);
    assert.match(outcome.ok ? outcome.text : "", /Example Domain/);
    assert.match(outcome.ok ? outcome.text : "", /sandbox_observe/);
  });

  test("已启动（status running）时不再 cdp-start：一条命令一次往返", async () => {
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-observe" });

    assert.equal(outcome.ok, true);
    assert.deepEqual(
      calls.map((call) => call.command),
      [computerUseGuestCommands.cdpStatus, computerUseGuestCommands.cdpObserve],
    );
  });

  test("没起过浏览器时 observe 不替模型起空白页：报「先 sandbox_navigate」，且不发 cdp-start", async () => {
    const { guest, calls } = fakeGuest({});
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-observe" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /sandbox_navigate/);
    assert.deepEqual(calls.map((call) => call.command), [computerUseGuestCommands.cdpStatus]);
  });

  test("缓存自愈：命令报「没有在运行」→ 清缓存、重起、重试一次（成功）", async () => {
    let navCalls = 0;
    let statusCalls = 0;
    const { guest, calls } = fakeGuest({
      running: true,
      replies: {
        // 第一次 status 说 running（缓存对应的就是那个时刻），但紧接着 nav 就报没了
        // （场景：用户在沙箱里关掉了 Edge 窗口 / 沙箱刚重启）——自愈时再问一次 status，
        // 这次必须说 false，宿主才会真的 cdp-start。
        [computerUseGuestCommands.cdpStatus]: () => {
          statusCalls += 1;
          return { ok: true, resp: { ok: true, running: statusCalls === 1, port: 12345 } };
        },
        [computerUseGuestCommands.cdpNav]: () => {
          navCalls += 1;
          if (navCalls === 1) return { ok: false, error: "沙箱里的 Edge 没有在运行（或已经退出）" };
          return { ok: true, resp: { ok: true, url: "https://example.com/", title: "Example", ms: 10 } };
        },
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-navigate", url: "https://example.com/" });

    assert.equal(outcome.ok, true);
    // status（首次）→ nav（失败）→ status（自愈时重新确认）→ start → nav（重试）
    assert.deepEqual(
      calls.map((call) => call.command),
      [
        computerUseGuestCommands.cdpStatus,
        computerUseGuestCommands.cdpNav,
        computerUseGuestCommands.cdpStatus,
        computerUseGuestCommands.cdpStart,
        computerUseGuestCommands.cdpNav,
      ],
    );
  });

  test("自愈只重试一次：第二次仍报没有运行就把人话抛出去，不无限打转", async () => {
    const { guest, calls } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpNav]: () => ({ ok: false, error: "沙箱里的 Edge 没有在运行" }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-navigate", url: "https://example.com/" });

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /没有在运行/);
    assert.equal(
      calls.filter((call) => call.command === computerUseGuestCommands.cdpNav).length,
      2,
    );
  });
});

describe("sandbox_* 回执翻成人话", () => {
  test("observe：URL/标题 + 正文 + 元素清单（选择器、文本、坐标、editable）", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpObserve]: () => ({
          ok: true,
          resp: {
            ok: true,
            url: "https://example.com/",
            title: "Example",
            text: "Hello world",
            totalTextLength: 11,
            truncated: false,
            elementCount: 2,
            elements: [
              { selector: "#submit", tag: "button", text: "Save", x: 100, y: 200, role: "", editable: false },
              { selector: "input[email]", tag: "input[email]", text: "Email", x: 10, y: 20, role: "", editable: true },
            ],
          },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-observe", maxElements: 50 });

    assert.equal(outcome.ok, true);
    const text = outcome.ok ? outcome.text : "";
    assert.match(text, /URL: https:\/\/example\.com\//);
    assert.match(text, /Hello world/);
    assert.match(text, /Interactive elements \(2\)/);
    assert.match(text, /selector #submit/);
    assert.match(text, /\[editable\]/);
  });

  test("observe：元素为空时给「可能还在加载」的下一步，而不是一句空清单", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpObserve]: () => ({
          ok: true,
          resp: { ok: true, url: "about:blank", title: "", text: "", elements: [] },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-observe" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.ok ? outcome.text : "", /no interactive elements/);
    assert.match(outcome.ok ? outcome.text : "", /sandbox_wait/);
  });

  test("type：clear 缺省 true、submit 原样下发，回执报当前值", async () => {
    const { guest, calls } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpType]: () => ({ ok: true, resp: { ok: true, value: "hello", submitted: false } }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-type", selector: "#q", text: "hello" });

    assert.equal(outcome.ok, true);
    const call = calls.find((item) => item.command === computerUseGuestCommands.cdpType);
    assert.deepEqual(call?.fields, { selector: "#q", text: "hello", submit: false, clear: true });
    assert.match(outcome.ok ? outcome.text : "", /"hello"/);
  });

  test("type：clear:false / submit:true 都传下去", async () => {
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, tempOutDir());
    await run(cdp, { action: "sandbox-type", selector: "#q", text: "x", clear: false, submit: true });
    const call = calls.find((item) => item.command === computerUseGuestCommands.cdpType);
    assert.deepEqual(call?.fields, { selector: "#q", text: "x", submit: true, clear: false });
  });

  test("extract：超长文本带总数与截断说明", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpExtract]: () => ({
          ok: true,
          resp: { ok: true, text: "abc", totalLength: 20003, truncated: true },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-extract" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.ok ? outcome.text : "", /20003 character\(s\) in total/);
    assert.match(outcome.ok ? outcome.text : "", /showing the first 3/);
  });

  test("wait：没出现也是 ok:true，但文案要说选择器可能不对 / 可以再等", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpWait]: () => ({
          ok: true,
          resp: { ok: true, appeared: false, waitedMs: 8000 },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-wait", selector: "#nope" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.ok ? outcome.text : "", /did not appear within 8000 ms/);
    assert.match(outcome.ok ? outcome.text : "", /sandbox_observe/);
  });

  test("screenshot：回执带图与两套尺寸（回图 1000×600 / 视口 1366×820）", async () => {
    const { guest } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-screenshot" });

    assert.equal(outcome.ok, true);
    const shot = outcome.ok ? outcome.shot : undefined;
    assert.ok(shot !== undefined, "截图必须带 shot");
    assert.equal(shot?.width, 1000);
    assert.equal(shot?.nativeWidth, 1366);
    assert.equal(shot?.data, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));
  });

  test("screenshot：回执缺尺寸时抛人话（不让 undefined 流进 IPC）", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpShot]: () => ({
          ok: true,
          jpeg: new Uint8Array([0xff, 0xd8]),
          resp: { ok: true, jpeg: "cmd-000001.jpg" },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-screenshot" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /缺尺寸字段/);
  });
});

describe("上传 / 下载：宿主侧的文件搬运", () => {
  test("upload：宿主文件拷进映射目录 upload/，下发的 guest 路径在 C:\\orbita-out\\upload\\ 下", async () => {
    const outDir = tempOutDir();
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), "orbita-cdp-src-"));
    const source = path.join(sourceDir, "report 2026.pdf");
    writeFileSync(source, "PDF-ish bytes");
    const { guest, calls } = fakeGuest({ running: true, replies: {
      [computerUseGuestCommands.cdpUpload]: (fields) => ({
        ok: true,
        resp: { ok: true, path: fields["path"], fileName: "report 2026.pdf" },
      }),
    } });
    const cdp = new CdpSession(guest, outDir);

    try {
      const outcome = await run(cdp, { action: "sandbox-upload", selector: "#file", path: source });
      assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);

      const call = calls.find((item) => item.command === computerUseGuestCommands.cdpUpload);
      const guestPath = String(call?.fields["path"]);
      assert.ok(guestPath.startsWith("C:\\orbita-out\\upload\\"), guestPath);
      assert.match(guestPath, /report 2026\.pdf$/);

      // 宿主侧真的落了盘（映射目录的另一半），内容原样
      const copied = readFileSync(path.join(outDir, "upload", path.basename(guestPath)), "utf8");
      assert.equal(copied, "PDF-ish bytes");
      assert.match(outcome.ok ? outcome.text : "", /report 2026\.pdf/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("upload：模型给正斜杠路径（C:/...）也能取对文件名，guest 路径仍落到 upload/", async () => {
    const outDir = tempOutDir();
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), "orbita-cdp-src-"));
    const source = path.join(sourceDir, "slash.pdf");
    writeFileSync(source, "bytes");
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, outDir);

    try {
      const outcome = await run(cdp, {
        action: "sandbox-upload",
        selector: "#file",
        // Windows 上同一个文件的另一种写法
        path: source.replaceAll("\\", "/"),
      });
      assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
      const call = calls.find((item) => item.command === computerUseGuestCommands.cdpUpload);
      const guestPath = String(call?.fields["path"]);
      assert.ok(guestPath.startsWith("C:\\orbita-out\\upload\\"), guestPath);
      assert.ok(guestPath.endsWith("-slash.pdf"), guestPath);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("upload：文件不存在 / 目录 / 空文件都当场报错，不发命令", async () => {
    const outDir = tempOutDir();
    const dirSource = path.join(outDir, "a-directory");
    mkdirSync(dirSource, { recursive: true });
    const empty = path.join(outDir, "empty.txt");
    writeFileSync(empty, "");
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, outDir);

    try {
      for (const source of [path.join(outDir, "missing.pdf"), dirSource, empty]) {
        const outcome = await run(cdp, { action: "sandbox-upload", selector: "#file", path: source });
        assert.equal(outcome.ok, false, source);
        assert.match(outcome.ok ? "" : outcome.error, /不是(一个)?文件|找不到|空的|文件名不可用/, source);
      }
      assert.equal(calls.some((call) => call.command === computerUseGuestCommands.cdpUpload), false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("download：guest 回的文件名翻成宿主路径；带 .. 的名字只保留末段、不许逃出下载目录", async () => {
    const outDir = tempOutDir();
    const downloadDir = path.join(outDir, "downloads", "run1");
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(path.join(downloadDir, "notes.txt"), "downloaded");
    writeFileSync(path.join(downloadDir, "secret.txt"), "not really secret");
    const { guest, calls } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpDownload]: () => ({
          ok: true,
          resp: { ok: true, dir: "C:\\orbita-out\\downloads\\run1", files: ["notes.txt", "..\\..\\secret.txt"] },
        }),
      },
    });
    const cdp = new CdpSession(guest, outDir);

    try {
      const outcome = await run(cdp, { action: "sandbox-download", selector: "#export", dir: "run1" });
      assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);

      const call = calls.find((item) => item.command === computerUseGuestCommands.cdpDownload);
      assert.equal(call?.fields["dir"], "C:\\orbita-out\\downloads\\run1");

      const text = outcome.ok ? outcome.text : "";
      assert.match(text, /notes\.txt/);
      assert.ok(text.includes(path.join(downloadDir, "notes.txt")), text);
      // 不可信文件名只取末段：`..\..\secret.txt` 落到下载目录里的 secret.txt，
      // 不会变成上一级目录的路径（拼接前先过 win32.basename，与截图文件名同一道闸门）
      assert.ok(text.includes(path.join(downloadDir, "secret.txt")), text);
      assert.equal(text.includes(".."), false, "宿主路径里不该出现 ..");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("download：dir 里的路径分隔符 / .. 不许逃出 downloads/（回落成时间戳目录）", async () => {
    const outDir = tempOutDir();
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, outDir);

    try {
      for (const bad of ["../../etc", "..", "."]) {
        await run(cdp, { action: "sandbox-download", selector: "#export", dir: bad });
        const call = calls[calls.length - 1];
        const dir = String(call?.fields["dir"]);
        assert.ok(dir.startsWith("C:\\orbita-out\\downloads\\"), dir);
        assert.equal(dir.includes(".."), false, dir);
        // `.` / `..` 都不能变成「就是 downloads 本身」
        assert.notEqual(dir.replace(/\\+$/, ""), "C:\\orbita-out\\downloads", dir);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("download：没文件落盘时翻成失败并说清「链接可能不是下载」，不谎报成功", async () => {
    const outDir = tempOutDir();
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpDownload]: () => ({
          // 桥把「没落盘」当命令失败回（生产里 sendGuestCommand 会把它抛成 Error）
          ok: false,
          error: "20 秒内没有文件落到下载目录（链接可能不是下载）",
        }),
      },
    });
    const cdp = new CdpSession(guest, outDir);
    try {
      // 失败要翻成人话，而不是谎报「下载了 0 个文件」
      const outcome = await run(cdp, { action: "sandbox-download", selector: "#export" });
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? "" : outcome.error, /20 秒内没有文件/);
      assert.match(outcome.ok ? "" : outcome.error, /computer_screenshot/, "失败要带降级指引");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("停浏览器", () => {
  test("stop：发 cdp-stop 并清掉「已启动」缓存；桥不响应也不抛（停沙箱时是常态）", async () => {
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, tempOutDir());
    await run(cdp, { action: "sandbox-observe" });
    assert.equal(calls[0]?.command, computerUseGuestCommands.cdpStatus);

    await cdp.stop();
    assert.equal(calls[calls.length - 1]?.command, computerUseGuestCommands.cdpStop);

    const failing: CdpGuest = {
      async guestCommandReply() {
        return { ok: false, error: "guest 桥 45000ms 内没有响应（cdp-stop 超时）" };
      },
      async guestShot() {
        return { ok: false, error: "不该走到这里" };
      },
    };
    await new CdpSession(failing, tempOutDir()).stop(); // 不抛
  });
});

describe("标签页", () => {
  test("tabs：list 回清单并标出 active；switch 说清「切过去了，要重新 observe」", async () => {
    const { guest, calls } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpTabs]: (fields) => ({
          ok: true,
          resp: {
            ok: true,
            active: fields["op"] === "switch" ? 1 : 0,
            count: 2,
            tabs: [
              { index: 0, id: "A", url: "https://a.example/", title: "A", active: fields["op"] !== "switch" },
              { index: 1, id: "B", url: "https://b.example/", title: "B", active: fields["op"] === "switch" },
            ],
          },
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());

    const listed = await run(cdp, { action: "sandbox-tabs" });
    assert.equal(listed.ok, true);
    const listText = listed.ok ? listed.text : "";
    assert.match(listText, /2 tab\(s\)/);
    assert.match(listText, /\* \[0\] A — https:\/\/a\.example\//);

    const switched = await run(cdp, { action: "sandbox-tabs", op: "switch", index: 1 });
    assert.equal(switched.ok, true);
    assert.match(switched.ok ? switched.text : "", /Switched to tab 1/);
    assert.match(switched.ok ? switched.text : "", /observe again/);
    const last = calls[calls.length - 1];
    assert.deepEqual(last?.fields, { op: "switch", index: 1 });
  });
});

describe("失败文案", () => {
  test("CDP 失败要带「可以退回像素工具」的指引（模型只有这句话能换道）", async () => {
    const { guest } = fakeGuest({
      running: true,
      replies: {
        [computerUseGuestCommands.cdpClick]: () => ({
          ok: false,
          error: "选择器「#nope」在页面上没有匹配到可见元素",
        }),
      },
    });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "sandbox-click", selector: "#nope" });

    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /没有匹配到可见元素/);
    assert.match(error, /computer_screenshot/);
    assert.match(error, /computer_click/);
    // 指引只出现一次，不叠两遍
    assert.equal(error.split("fall back to the pixel tools").length - 1, 1, error);
  });

  test("非 sandbox 动作进错层：报内部错误，不去调 CDP", async () => {
    const { guest, calls } = fakeGuest({ running: true });
    const cdp = new CdpSession(guest, tempOutDir());
    const outcome = await run(cdp, { action: "click", x: 1, y: 2 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /内部错误/);
    assert.deepEqual(calls, []);
  });
});
