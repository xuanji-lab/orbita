/**
 * L3 后端的单测：**命令怎么落到 guest、做不到的怎么明拒**。
 *
 * 不起 VM：把 bootVm / stopVm 换成假的，guest 那端仍是本地一个 HTTP 服务（协议与真 guest
 * 同形，见 qemu-guest.test.ts）。这样验的是这一层自己做的四件事：
 *   1. 像素命令 → CGI 字段（坐标、按钮、双击、base64 文本）；
 *   2. 截图 → PNG + mime + 原生屏尺寸（坐标换算靠它）；
 *   3. **能力降级必须显式**：没有 UIA / 没有按窗口截图 / 没接 CDP 时，回一句带替代路径的话；
 *   4. 生命周期：起、停、起失败要收尸，没在跑时车道方法回同一句「先启动」。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import {
  computerUseGuestCommands,
  COMPUTER_USE_DESKTOP_KEY,
  type SandboxState,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { sandboxNotRunningText } from "./provider.ts";
import { QEMU_CAPABILITIES, QEMU_REFUSALS, QemuSandboxProvider } from "./qemu.ts";
import { qemuAccelSpec, qemuNetdevSpec, qemuVmArgs } from "./qemu-vm.ts";
import type { QemuVmHandle, QemuVmOptions, QemuVmPorts } from "./qemu-vm.ts";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // 噪声填充：纯色 PNG 会压到 1KB 以下，而 provider 的「等桌面画出来」以 20KB 为界
  // （真桌面的壁纸/图标远大于它）。用 xorshift 造不可压缩的像素，免得单测白等 8 秒。
  const raw = Buffer.alloc(height * (1 + width * 3));
  let seed = 0x9e3779b9;
  for (let index = 0; index < raw.length; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    raw[index] = seed & 0xff;
  }
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parseBody(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

describe("QemuSandboxProvider：L3 的命令映射与能力降级", () => {
  const received: Record<string, string>[] = [];
  let server: http.Server;
  let port = 0;
  const stopped: number[] = [];

  before(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const fields = parseBody(Buffer.concat(chunks).toString("utf8"));
        received.push(fields);
        const cmd = fields["cmd"];
        if (cmd === "shot") {
          // 缩放百分比要能对上（PCT 是 50 时给一张 640 宽的图）
          const percent = fields["thumb"] === "50" ? 0.5 : 1;
          response.writeHead(200, { "content-type": "image/png" });
          response.end(makePng(Math.round(1280 * percent), Math.round(800 * percent)));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        if (cmd === "ping") {
          response.end('{"ok":true,"w":1280,"h":800,"desktop":1,"version":"p3-guestd-1"}');
          return;
        }
        if (cmd === "winlist") {
          response.end(
            '{"ok":true,"windows":[' +
              '{"id":16777219,"title":"xfce4-panel","x":0,"y":0,"w":1280,"h":27,"pid":1242},' +
              '{"id":14680108,"title":"Desktop","x":0,"y":0,"w":1280,"h":800,"pid":1255}]}',
          );
          return;
        }
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    port = address.port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 假指针：记下调用就够（真要验字节的是 qemu-rfb.test.ts） */
  const pointerCalls: { op: string; x: number; y: number; button?: string; double?: boolean; notches?: number }[] = [];

  /** 假 VM：pid 用本进程的（alive），端口指向假 guest 服务 */
  function fakeProvider(overrides: { failBoot?: boolean; statuses?: SandboxState[] } = {}) {
    const ports: QemuVmPorts = { desk: port, monitor: 1, rfb: 2 };
    const provider = new QemuSandboxProvider({
      bootVm: (options: QemuVmOptions & { ports: QemuVmPorts }): QemuVmHandle => {
        if (overrides.failBoot === true) throw new Error("假的启动失败");
        // 端口必须指向这个假 guest 服务（不是现挑的空闲端口）：否则 waitForDesk 会等 90s
        void options;
        return {
          pid: process.pid,
          ports,
          token: "fake-token",
          qemuLog: "",
          serialLog: "",
          args: [],
          spawnedAt: Date.now(),
        };
      },
      stopVm: async (handle: QemuVmHandle) => {
        stopped.push(handle.pid);
        return { stopped: true, forced: false };
      },
      // 有记录就说明「每次迁移都通知了」这件事本身在跑（门面接的就是这个回调）
      ...(overrides.statuses === undefined
        ? {}
        : { onStatus: (status: SandboxStatus) => overrides.statuses!.push(status.state) }),
      openPointer: async () => ({
        click: async (x: number, y: number, options: { button?: "left" | "middle" | "right"; double?: boolean }) => {
          pointerCalls.push({ op: "click", x, y, button: options.button, double: options.double });
        },
        scroll: async (x: number, y: number, notches: number) => {
          pointerCalls.push({ op: "scroll", x, y, notches });
        },
        close: () => undefined,
      }),
    });
    void ports;
    return provider;
  }

  it("启动时读一次出网开关并交给 bootVm（断网只发生在「关」的档，且不影响桌面通道）", async () => {
    const ports: QemuVmPorts = { desk: port, monitor: 1, rfb: 2 };
    const seen: boolean[] = [];
    const provider = new QemuSandboxProvider({
      bootVm: (options: QemuVmOptions & { ports: QemuVmPorts }): QemuVmHandle => {
        seen.push(options.allowNetwork);
        return { pid: process.pid, ports, token: "fake-token", qemuLog: "", serialLog: "", args: [], spawnedAt: Date.now() };
      },
      stopVm: async (): Promise<{ stopped: boolean; forced: boolean }> => ({ stopped: true, forced: false }),
      openPointer: async () => ({
        click: async () => undefined,
        scroll: async () => undefined,
        close: () => undefined,
      }),
      allowNetwork: () => false,
    });
    await provider.start();
    assert.deepEqual(seen, [false], "设置里关着出网时，bootVm 必须收到 allowNetwork=false");
    await provider.stop();
  });

  it("没在跑时：车道方法回同一句「先启动」，不是静默空回", async () => {
    const provider = fakeProvider();
    const shot = await provider.screenshot();
    assert.equal(shot.ok, false);
    assert.equal(shot.ok === false ? shot.error : "", sandboxNotRunningText());
    const click = await provider.guestCommand(computerUseGuestCommands.click, { x: 1, y: 2 });
    assert.equal(click.ok, false);
    assert.equal(click.ok === false ? click.error : "", sandboxNotRunningText());
    assert.deepEqual(provider.status(), { state: "off" });
  });

  it("启动：等到桌面在就把 running 报出来（版本取自 ping）", async () => {
    const provider = fakeProvider();
    const started = await provider.start();
    assert.deepEqual(started, { ok: true });
    const status = provider.status();
    assert.equal(status.state, "running");
    assert.equal(status.state === "running" ? status.bridgeVersion : "", "p3-guestd-1");
    assert.equal(status.state === "running" ? status.backend : "", "qemu");
    assert.deepEqual(await provider.stop(), { ok: true });
    assert.equal(stopped.length, 1);
  });

  it("启动失败：状态是 error、错误是人话、VM 被收掉", async () => {
    const provider = fakeProvider({ failBoot: true });
    const started = await provider.start();
    assert.equal(started.ok, false);
    assert.match(started.ok === false ? started.error : "", /假的启动失败/);
    assert.equal(provider.status().state, "error");
  });

  it("截图：PNG + mime + 原生屏尺寸；maxWidth 折成 scrot 的百分比", async () => {
    const provider = fakeProvider();
    await provider.start();
    received.length = 0;
    const shot = await provider.screenshot(640);
    assert.equal(shot.ok, true);
    if (shot.ok) {
      assert.equal(shot.mime, "image/png");
      assert.equal(shot.width, 640);
      assert.equal(shot.height, 400);
      // 原生尺寸是**屏**的尺寸，不是回图的——坐标换算靠这一对
      assert.equal(shot.nativeWidth, 1280);
      assert.equal(shot.nativeHeight, 800);
      assert.ok(shot.jpegBase64.length > 0);
    }
    const shotCmd = received.find((fields) => fields["cmd"] === "shot");
    assert.equal(shotCmd?.["thumb"], "50");
    await provider.stop();
  });

  it("指针命令走 RFB（菜单点得开的唯一一条路），键盘与打字走 guest 的 CGI", async () => {
    const provider = fakeProvider();
    received.length = 0;
    pointerCalls.length = 0;
    await provider.start();

    const click = await provider.guestCommand(computerUseGuestCommands.click, { x: 60.4, y: 12.5, button: "right", double: true });
    assert.equal(click.ok, true);
    assert.deepEqual(pointerCalls.at(-1), { op: "click", x: 60, y: 13, button: "right", double: true });
    // 点击不发 HTTP：guest 的 CGI 里已经没有 click 这条命令
    assert.equal(received.filter((fields) => fields["cmd"] === "click").length, 0);

    await provider.guestCommand(computerUseGuestCommands.type, { text: 'echo "你好"' });
    assert.equal(received.at(-1)?.["cmd"], "type");
    assert.equal(Buffer.from(received.at(-1)?.["b64"] ?? "", "base64").toString("utf8"), 'echo "你好"');

    await provider.guestCommand(computerUseGuestCommands.key, { key: "ctrl+s" });
    assert.equal(Buffer.from(received.at(-1)?.["b64"] ?? "", "base64").toString("utf8"), "ctrl+s");

    await provider.guestCommand(computerUseGuestCommands.scroll, { x: 5, y: 6, deltaY: -3 });
    assert.deepEqual(pointerCalls.at(-1), { op: "scroll", x: 5, y: 6, notches: -3 });
    await provider.stop();
  });

  it("参数不对就明说（缺坐标 / 空文本），不下发一条会「成功」的空命令", async () => {
    const provider = fakeProvider();
    await provider.start();
    const click = await provider.guestCommand(computerUseGuestCommands.click, { y: 3 });
    assert.equal(click.ok, false);
    assert.match(click.ok === false ? click.error : "", /x \/ y/);
    const typed = await provider.guestCommand(computerUseGuestCommands.type, { text: "" });
    assert.equal(typed.ok, false);
    assert.match(typed.ok === false ? typed.error : "", /空的|空/);
    await provider.stop();
  });

  it("能力降级：UIA / 按窗口截图 / CDP 各回一句**带替代路径**的话", async () => {
    const provider = fakeProvider();
    await provider.start();

    const uiaList = await provider.uiaList();
    assert.equal(uiaList.ok, false);
    assert.equal(uiaList.ok === false ? uiaList.error : "", QEMU_REFUSALS.uia);
    // 模型看不见界面：这句话必须告诉它换 screenshot + 坐标
    assert.match(QEMU_REFUSALS.uia, /computer_screenshot/);
    assert.match(QEMU_REFUSALS.uia, /computer_click/);

    const uiaAct = await provider.uiaAct({ perform: "invoke" });
    assert.equal(uiaAct.ok, false);

    const windowShot = await provider.windowShot();
    assert.equal(windowShot.ok, false);
    assert.match(windowShot.ok === false ? windowShot.error : "", /整桌面截图/);

    const cdp = await provider.guestShot(computerUseGuestCommands.cdpShot);
    assert.equal(cdp.ok, false);
    assert.equal(cdp.ok === false ? cdp.error : "", QEMU_REFUSALS.cdp);

    // 不认识的命令要点名它认识哪些（而不是一个空 ok）
    const unknown = await provider.guestCommand(computerUseGuestCommands.uiaAct, {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok === false ? unknown.error : "", /click \/ type \/ key \/ scroll/);

    // 声明与实现同源：这三项在 capabilities 里就是 false
    assert.equal(QEMU_CAPABILITIES.uia, false);
    assert.equal(QEMU_CAPABILITIES.windows, false);
    assert.equal(QEMU_CAPABILITIES.cdp, false);
    assert.equal(QEMU_CAPABILITIES.realPointer, true);
    await provider.stop();
  });

  it("win-list 仍然可用（按窗口拍不了，但能告诉模型桌面上有什么）", async () => {
    const provider = fakeProvider();
    await provider.start();
    const list = await provider.listWindows();
    assert.equal(list.ok, true);
    if (list.ok) {
      assert.equal(list.windows.length, 2);
      assert.equal(list.windows[0]?.hwnd, 16777219);
      assert.equal(list.windows[0]?.title, "xfce4-panel");
      assert.equal(list.windows[1]?.h, 800);
    }
    await provider.stop();
  });

  it("租约：一台 VM 一块屏幕 → 全局独占键（不是每会话一把）", () => {
    const provider = fakeProvider();
    assert.equal(provider.desktopKey("session-a"), COMPUTER_USE_DESKTOP_KEY);
    assert.equal(provider.desktopKey("session-b"), COMPUTER_USE_DESKTOP_KEY);
    assert.equal(provider.capabilities.desktopScope, "shared");
  });

  /**
   * 状态迁移的通知（2026-11-28 真机 P0 的账）。
   *
   * 真机上 QEMU 起完 7–8 秒、端口在听、截图是 XFCE，设置页却一直「未启动」：
   * 这个 provider 从来没有把迁移告诉任何人，于是 computer-use:status 一条都不推，
   * 「关闭」按钮一直是灰的——用户在设置页停不掉那台 VM。下面两条盯的就是
   * 「每一次迁移都有通知」，包括失败那条。
   */
  describe("QEMU 状态迁移的通知（设置页靠它画状态与按钮）", () => {
    /** 假的坚持要用的那台 guest 服务在本 describe 之外；这里直接借第一个 describe 的 fakeProvider */
    it("启动 → starting、running；停止 → stopping、off（四条一条不少、顺序不变）", async () => {
      const statuses: SandboxState[] = [];
      const provider = fakeProvider({ statuses });
      await provider.start();
      await provider.stop();
      assert.deepEqual(statuses, ["starting", "running", "stopping", "off"]);
    });

    it("启动失败 → starting、error（界面才不会停在「启动中」）", async () => {
      const statuses: SandboxState[] = [];
      const provider = fakeProvider({ failBoot: true, statuses });
      const started = await provider.start();
      assert.equal(started.ok, false);
      assert.deepEqual(statuses, ["starting", "error"]);
    });

    it("subscribeStatus 与构造参数的 onStatus 共用一张订阅表（门面两条路不会分叉）", async () => {
      const viaHook: SandboxState[] = [];
      const viaSubscribe: SandboxState[] = [];
      const provider = fakeProvider({ statuses: viaHook });
      provider.subscribeStatus((status) => viaSubscribe.push(status.state));
      await provider.start();
      assert.deepEqual(viaHook, ["starting", "running"]);
      assert.deepEqual(viaSubscribe, ["starting", "running"], "门面给注入的 provider 接线走的就是这条");
    });
  });
});

/**
 * 能力声明里的 evidence（证据级别）——**必须与实现同源**。
 * L3 的 Linux 桌面没有 UIA（读不到控件值）、也没有按窗口截图（只有整屏像素），
 * 所以像素动作之后我们没有任何精确读回：evidence 必须是 none。
 * 工具层据此永不出 confirmed / suspected_noop，并让模型点完自己截图确认。
 * 这个值是 P0-4 的前提，**不要为了好看改成 window**。
 */
describe("能力声明：证据级别与实现同源（L3 / QEMU Linux 桌面）", () => {
  it("没有 UIA、没有按窗口截图 ⇒ evidence 必须是 none", () => {
    assert.equal(QEMU_CAPABILITIES.uia, false);
    assert.equal(QEMU_CAPABILITIES.windows, false);
    assert.equal(QEMU_CAPABILITIES.evidence, "none");
    // provider.ts 的一致性规则：uia ⇒ value；否则 windows ⇒ window；否则 none
    const implied = QEMU_CAPABILITIES.uia ? "value" : QEMU_CAPABILITIES.windows ? "window" : "none";
    assert.equal(QEMU_CAPABILITIES.evidence, implied, "声明得比实现高就是伪造证据");
  });
});

/**
 * 起 VM 的加速器串：`kernel-irqchip=off` 是**实测**换来的（x86_64 + WHPX 上 MSI 注入失败
 * 从 1 行降到 0 行、桌面照常可用），所以钉死具体字符串——顺手改成 `-cpu` 属性、或把属性
 * 写到别的 accel 上，都会在真机上悄悄失效而测试不一定看得出来。
 * 同时钉住「其它 arch / accel 不加」：加宽条件会改变别人的命令行语义。
 */
describe("QEMU 加速器参数：只给 x86_64 + WHPX 关内核 irqchip", () => {
  it("x86_64 + whpx ⇒ kernel-irqchip=off", () => {
    assert.equal(qemuAccelSpec("x64", "whpx"), "whpx,kernel-irqchip=off");
  });

  it("其它架构 / 其它加速器一律保持原样", () => {
    assert.equal(qemuAccelSpec("arm64", "whpx"), "whpx");
    assert.equal(qemuAccelSpec("x64", "hvf"), "hvf");
    assert.equal(qemuAccelSpec("ia32", "whpx"), "whpx");
  });
});


/**
 * 出网开关落到 QEMU 命令行：`-netdev user` 上的 `restrict=on`。
 *
 * 两件事必须同时成立，少一件就是回归：
 *   1. 关掉出网时 guest 出不去（restrict=on）——QEMU 文档：「isolate guest from the rest of
 *      the network」；restrict 只管隐式的出站 / 入站，**不作用于显式 hostfwd**；
 *   2. 桌面通道的两条 hostfwd（8080 桌面服务、5900 RFB）一个都不能丢——丢了断网变断腿，
 *      截屏与指针输入全部失效。开着出网时反过来：不能带 restrict（用户选了允许）。
 * 真起一台 VM 要镜像与 QEMU 二进制（仓外产物），所以这里只断言拼出来的参数。
 */
describe("QEMU 出网开关：restrict=on 只加在「关」上，hostfwd 一条都不能丢", () => {
  const ports: QemuVmPorts = { desk: 6250, monitor: 6251, rfb: 6252 };

  it("关掉出网：restrict=on 与两条 hostfwd 同时在", () => {
    const spec = qemuNetdevSpec(ports, false);
    assert.match(spec, /restrict=on/);
    assert.ok(spec.includes(`hostfwd=tcp:127.0.0.1:${ports.desk}-:8080`), spec);
    assert.ok(spec.includes(`hostfwd=tcp:127.0.0.1:${ports.rfb}-:5900`), spec);
    assert.match(spec, /^user,id=n0,/);
  });

  it("开着出网：不带 restrict（用户选了允许），转发规则照旧", () => {
    const spec = qemuNetdevSpec(ports, true);
    assert.doesNotMatch(spec, /restrict/);
    assert.ok(spec.includes(`hostfwd=tcp:127.0.0.1:${ports.desk}-:8080`), spec);
    assert.ok(spec.includes(`hostfwd=tcp:127.0.0.1:${ports.rfb}-:5900`), spec);
  });

  it("整条命令行里 -netdev 后面跟的就是那份串（拼命令行时没被覆盖 / 漏掉）", () => {
    const args = qemuVmArgs({
      paths: {
        imageDir: "C:/img",
        qemuDir: "C:/qemu",
        qemu: "C:/qemu/qemu-system-x86_64.exe",
        disk: "C:/img/desktop.qcow2",
        kernel: "C:/img/vmlinuz",
        initrd: "C:/img/initrd.gz",
      },
      ports,
      token: "t0ken",
      allowNetwork: false,
      serialLog: "C:/img/serial.log",
    });
    const at = args.indexOf("-netdev");
    assert.ok(at >= 0);
    const spec = args[at + 1] ?? "";
    assert.ok(spec.includes("restrict=on"), spec);
    assert.ok(spec.includes("hostfwd="), spec);
  });
});
