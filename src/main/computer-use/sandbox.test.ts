import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_INFO_FILE,
  COMPUTER_USE_CMD_DIR,
  COMPUTER_USE_DEFAULT_ALLOW_NETWORK,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import { parseBridgeInfo, waitForBridgeInfo } from "./bridge-ready.ts";
import { type SandboxProcessInfo } from "./process-list.ts";
import {
  COMPUTER_USE_GUEST_APP_EXE,
  renderWsbXml,
  SandboxController,
  type SandboxDeps,
  type SandboxProcess,
} from "./sandbox.ts";

// ── 假沙箱进程：只实现状态机用到的 on / kill，exit / error 由测试手动发射 ─────────

class FakeSandboxProcess implements SandboxProcess {
  killed = false;
  /** 进程 id（升级杀 `killTreeByPid` 认它） */
  readonly pid = 4242;
  /** 退出码：null = 还在跑（Node 的 ChildProcess 语义）；emitExit 会把它写上 */
  exitCode: number | null = null;
  /** kill() 被调了几次——「升级时是不是真的又打了一次」看它 */
  killCount = 0;
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)): void {
    if (event === "exit") this.exitListeners.push(listener as (code: number | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }

  kill(): boolean {
    this.killed = true;
    this.killCount += 1;
    return true;
  }

  emitExit(code: number | null): void {
    this.exitCode = code ?? 0;
    for (const listener of this.exitListeners) listener(code);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

// ── 测试脚手架 ──────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await sleep(10);
  }
}

type BridgeReq = {
  seq: number;
  command: string;
  maxWidth?: number;
  hwnd?: number;
  title?: string;
  maxItems?: number;
  ref?: number;
  name?: string;
  action?: string;
  value?: string;
  timeoutMs?: number;
};
type BridgeAnswer = { resp: Record<string, unknown>; jpg?: Buffer };
/** null = 装死不应答（模拟死桥；req 文件留着不删，与真桥死亡时的现场一致） */
type Responder = (req: BridgeReq) => BridgeAnswer | null;

interface Harness {
  controller: SandboxController;
  dir: string;
  spawned: FakeSandboxProcess[];
  spawnedWsb: string[];
  events: SandboxStatus[];
  /**
   * 模拟桥上线：写 bridge.json 通告 + 启动命令应答器。
   * respond 缺省 = 只答 ping（状态机测试够用）；截图测试传自己的 handler（记得也要答 ping）；
   * respond 传 null = 通告了但命令通道装死（验 ping 超时路径）。
   */
  announceBridge(options?: { delayMs?: number; respond?: Responder | null }): void;
  /** 已应答的请求记录 */
  requests: BridgeReq[];
  /** 控制器写过的日志（收尾链的「痕迹」就在这里面） */
  logs: string[];
  /** close() 后置位，命令应答器循环据此退出（不然 node --test 被永续循环拖着不退出） */
  closed: boolean;
  close(): Promise<void>;
}

async function makeHarness(overrides: Partial<SandboxDeps> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-computer-use-"));
  const harness: Harness = {
    controller: null as unknown as SandboxController,
    dir,
    spawned: [],
    spawnedWsb: [],
    events: [],
    requests: [],
    logs: [],
    closed: false,
    announceBridge: (options = {}) => {
      const delayMs = options.delayMs ?? 30;
      const respond: Responder | null | undefined = options.respond;
      void (async () => {
        await sleep(delayMs);
        const outDir = join(dir, "out");
        // start() 里 out 目录是异步建的，撞 ENOENT 就等下一轮（模拟真实时序抖动）
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            await mkdir(outDir, { recursive: true });
            await writeFile(join(outDir, BRIDGE_INFO_FILE), JSON.stringify({ version: "test", pid: 42 }), "utf8");
            break;
          } catch {
            await sleep(10);
          }
        }
        // respond === null 表示「通告了但命令通道不通」（ping 超时路径）
        if (respond === null) return;
        const handler: Responder = respond ?? ((req) => (req.command === "ping" ? { resp: { ok: true } } : null));
        const cmdDir = join(outDir, COMPUTER_USE_CMD_DIR);
        while (!harness.closed) {
          try {
            const files = (await readdir(cmdDir)).filter((f) => f.endsWith(".req.json")).sort();
            for (const file of files) {
              const baseName = file.slice(0, -".req.json".length);
              const req = JSON.parse(await readFile(join(cmdDir, file), "utf8")) as BridgeReq;
              harness.requests.push(req);
              const answer = handler(req);
              if (answer === null) continue; // 装死：不回 resp、不删 req
              const { resp, jpg } = answer;
              if (jpg !== undefined) await writeFile(join(cmdDir, `${baseName}.jpg`), jpg);
              await writeFile(join(cmdDir, `${baseName}.resp.json`), JSON.stringify(resp), "utf8");
              await rm(join(cmdDir, file), { force: true });
            }
          } catch {
            // 目录还没建 / 同步抖动，下一轮
          }
          await sleep(20);
        }
      })();
    },
    close: async () => {
      harness.closed = true;
      harness.controller.dispose();
      // Windows 上杀软 / 索引器会瞬时锁住新建的 .wsb，rm 偶发 ENOTEMPTY，退避重试几下
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt >= 4) throw error;
          await sleep(50 * (attempt + 1));
        }
      }
    },
  };
  harness.controller = new SandboxController({
    // 状态机测试模拟的是 Windows 环境（bridgeDir / sandboxExePath 都是 C:\…）：平台闸门
    // 要看 win32；平台不对的那条路径单独用 platform: "darwin" 覆写测
    platform: "win32",
    computerUseDir: dir,
    bridgeDir: "C:\\fake\\bridge",
    sandboxExePath: "C:\\Windows\\System32\\WindowsSandbox.exe",
    spawnSandbox: (wsbPath) => {
      const proc = new FakeSandboxProcess();
      harness.spawned.push(proc);
      harness.spawnedWsb.push(wsbPath);
      return proc;
    },
    fileExists: () => true,
    bridgePollIntervalMs: 20,
    onStatus: (status) => harness.events.push(status),
    log: (message) => harness.logs.push(message),
    ...overrides,
  });
  return harness;
}

function requireProc(harness: Harness): FakeSandboxProcess {
  const proc = harness.spawned[0];
  if (proc === undefined) throw new Error("沙箱进程没有被 spawn");
  return proc;
}

const states = (events: SandboxStatus[]): string[] => events.map((event) => event.state);

// ── .wsb 生成 ──────────────────────────────────────────────────────────

describe("renderWsbXml", () => {
  test("XML 转义：路径里的 & < > 引号 / 中文 / 空格都不破坏结构", () => {
    const xml = renderWsbXml({
      bridgeDir: 'C:\\Users\\达 玛 & <同事>\\orbita "dev"\\guest-bridge\\bin',
      outputDir: "C:\\Users\\达 玛\\AppData\\Roaming\\orbita-dev\\computer-use\\out",
    });
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.ok(
      xml.includes("<HostFolder>C:\\Users\\达 玛 &amp; &lt;同事&gt;\\orbita &quot;dev&quot;\\guest-bridge\\bin</HostFolder>"),
    );
    // 只读映射桥目录、读写映射输出目录
    const readOnlyParts = xml.split("<ReadOnly>").slice(1);
    assert.deepEqual([readOnlyParts[0]?.split("</")[0], readOnlyParts[1]?.split("</")[0]], ["true", "false"]);
    assert.ok(xml.includes("<Networking>Default</Networking>"));
  });

  test("内存配额：MemoryInMB = 4096，位置在 Networking 之后、MappedFolders 之前", () => {
    // 一个会话一个 Edge（最多 4 个）：guest 空载 0.9–1.2GB + 每个 ~0.4GB，不给配额就会被动杀
    // 进程（现场是「Edge 莫名其妙退出」）。元素顺序按官方 schema：MemoryInMB 在 Networking
    // 之后、MappedFolders 之前——顺序错了 WSB 直接报「配置文件格式错误」。
    const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out" });
    assert.ok(xml.includes("<MemoryInMB>4096</MemoryInMB>"), xml);
    const networkAt = xml.indexOf("<Networking>");
    const memoryAt = xml.indexOf("<MemoryInMB>");
    const foldersAt = xml.indexOf("<MappedFolders>");
    assert.ok(networkAt > 0 && memoryAt > networkAt && foldersAt > memoryAt);
    // 两条映射与它们的 SandboxFolder 不因为多了一个元素而改
    assert.deepEqual(
      mappedFolders(xml).map((folder) => folder.sandbox),
      ["C:\\Users\\WDAGUtilityAccount\\Desktop\\bin", "C:\\Users\\WDAGUtilityAccount\\Desktop\\out"],
    );
  });

  test("LogonCommand：junction 并到协议固定路径，桥只带 --out-dir（文件协议无 token/端口）", () => {
    const xml = renderWsbXml({ bridgeDir: "C:\\some path\\guest-bridge\\bin", outputDir: "C:\\out dir\\out" });
    const command = /<Command>(.+)<\/Command>/s.exec(xml)?.[1] ?? "";
    assert.ok(command.includes("cmd.exe /c &quot;"), "命令应包在 cmd.exe /c 里");
    assert.ok(command.includes("mklink /J C:\\orbita-bridge C:\\Users\\WDAGUtilityAccount\\Desktop\\bin"));
    assert.ok(command.includes("mklink /J C:\\orbita-out C:\\Users\\WDAGUtilityAccount\\Desktop\\out"));
    assert.ok(command.includes("C:\\orbita-bridge\\orbita-guest-bridge.exe --out-dir C:\\orbita-out"));
    assert.ok(command.includes("1&gt; C:\\orbita-out\\bridge.log 2&gt;&amp;1"), "桥的日志应重定向进 out 目录（诊断通道）");
    assert.ok(!command.includes("--token"), "文件协议没有 token");
    assert.ok(!command.includes("--listen-port"), "文件协议没有端口");
    assert.ok(command.includes("&amp;&amp;"), "&& 必须转义成 &amp;&amp;");
    assert.ok(!command.includes("&&"), "不允许裸 && 留在 XML 里");
  });

  // ── 显式 SandboxFolder（2026-10-24 真机：缺它导致 launch 扑空、桥可能没起）─────
  //
  // WSB 对没有 SandboxFolder 的映射按**宿主目录名**派生落点（`...\dist\win-unpacked` →
  // `Desktop\win-unpacked`），与代码假设的 `Desktop\orbita-app` 无关。所以每条映射都必须
  // 写死绝对 guest 路径，且 junction 的目标必须就是同一个落点。

  test("每条映射都有 SandboxFolder，且 junction 目标与它一致", () => {
    const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out", appDir: "C:\\c\\win-unpacked" });
    const folders = mappedFolders(xml);
    assert.equal(folders.length, 3);
    assert.deepEqual(
      folders.map((folder) => folder.sandbox),
      [
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\bin",
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\out",
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app",
      ],
    );
    // junction 的目标就是 SandboxFolder（bridge / out 两条）
    const command = /<Command>(.+)<\/Command>/s.exec(xml)?.[1] ?? "";
    assert.ok(command.includes(`mklink /J C:\\orbita-bridge ${folders[0]?.sandbox ?? ""}`));
    assert.ok(command.includes(`mklink /J C:\\orbita-out ${folders[1]?.sandbox ?? ""}`));
  });

  test("落点不随宿主目录名漂移：换名宿主目录，SandboxFolder 不变", () => {
    // 打包产物宿主目录名是 win-unpacked（不是 orbita-app）：缺 SandboxFolder 时 WSB 会落到
    // Desktop\win-unpacked，这里锁住「显式写死」这件事
    const xml = renderWsbXml({ bridgeDir: "C:\\x\\guest-bridge-bin", outputDir: "C:\\y\\cu-out", appDir: "C:\\z\\win-unpacked" });
    assert.deepEqual(
      mappedFolders(xml).map((folder) => folder.sandbox),
      [
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\bin",
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\out",
        "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app",
      ],
    );
  });

  test("bin / out 的 SandboxFolder 与 guest 协议固定路径一致（不然 junction 指着空的）", () => {
    const folders = mappedFolders(renderWsbXml({ bridgeDir: "C:\\a\\whatever", outputDir: "C:\\b\\whatever" }));
    // 协议固定路径是 C:\orbita-bridge / C:\orbita-out，由 LogonCommand 的 junction 并过去；
    // 落点必须在桌面下、末段名分别是 bin / out（junction 命令里写的就是这两个）
    assert.match(folders[0]?.sandbox ?? "", /^C:\\Users\\WDAGUtilityAccount\\Desktop\\bin$/);
    assert.match(folders[1]?.sandbox ?? "", /^C:\\Users\\WDAGUtilityAccount\\Desktop\\out$/);
  });

  // ── 打包产物映射（PR5）───────────────────────────────────────────────
  //
  // 这条映射是可选的：没出包时 .wsb 必须少一条 MappedFolder，而不是写一条指向不存在目录的
  // 映射（那会让整个沙箱起不来）。两种情况都必须是合法 XML，且只在有产物时才多出那一条。

  test("无打包产物：只有两条映射，且不出现 orbita-app / appDir", () => {
    const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out" });
    assert.equal(mappedFolders(xml).length, 2);
    assert.ok(!xml.includes("orbita-app"), "没传 appDir 就不该出现打包产物的映射");
    assert.equal(readOnlyFlags(xml).join(","), "true,false");
    // 少一条映射也不能少 SandboxFolder：桥与 out 仍然必须有显式落点
    assert.deepEqual(
      mappedFolders(xml).map((folder) => folder.sandbox),
      ["C:\\Users\\WDAGUtilityAccount\\Desktop\\bin", "C:\\Users\\WDAGUtilityAccount\\Desktop\\out"],
    );
  });

  test("有打包产物：多一条只读映射，宿主路径转义，LogonCommand 不变", () => {
    const appDir = "C:\\Users\\达 玛 & <dev>\\orbita\\dist\\win-unpacked";
    const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out", appDir });
    const folders = mappedFolders(xml);
    assert.equal(folders.length, 3, "第三条是打包产物映射");
    assert.deepEqual(folders, [
      { host: "C:\\a\\bin", sandbox: "C:\\Users\\WDAGUtilityAccount\\Desktop\\bin", readOnly: "true" },
      { host: "C:\\b\\out", sandbox: "C:\\Users\\WDAGUtilityAccount\\Desktop\\out", readOnly: "false" },
      {
        host: "C:\\Users\\达 玛 &amp; &lt;dev&gt;\\orbita\\dist\\win-unpacked",
        sandbox: "C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app",
        readOnly: "true",
      },
    ]);
    // LogonCommand 不因为多一条映射而变（app 映射没有要建的 junction）
    const command = /<Command>(.+)<\/Command>/s.exec(xml)?.[1] ?? "";
    assert.ok(command.includes("mklink /J C:\\orbita-bridge"));
    assert.ok(!command.includes("orbita-app"), "打包产物不进 LogonCommand（没有要建的 junction）");
  });

  test("Xml 合法性：tag 配对、根元素、映射顺序稳定（两种情况都是）", () => {
    for (const appDir of [undefined, "C:\\repo\\dist\\win-unpacked"]) {
      const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out", ...(appDir === undefined ? {} : { appDir }) });
      assertLegalWsb(xml);
    }
  });

  test("COMPUTER_USE_GUEST_APP_EXE 与 app 映射的 SandboxFolder 指向同一目录（同一个常量拼出来）", () => {
    // 曾经两边各写一遍：XML 假设 Desktop\\orbita-app，而缺 SandboxFolder 时 WSB 实际落到
    // Desktop\\win-unpacked，于是 launch 扑空。现在由 SandboxFolder 的目录部分 + 文件名拼出。
    const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out", appDir: "C:\\repo\\dist\\win-unpacked" });
    const appFolder = mappedFolders(xml)[2]?.sandbox ?? "";
    assert.notEqual(appFolder, "", "有产物时必须有 app 的 SandboxFolder");
    assert.equal(`${appFolder}\\orbita.exe`, COMPUTER_USE_GUEST_APP_EXE);
    assert.match(COMPUTER_USE_GUEST_APP_EXE, /^C:\\Users\\WDAGUtilityAccount\\Desktop\\orbita-app\\orbita\.exe$/);
  });

  // ── 出网开关（设置 › 实验功能 › 电脑使用）───────────────────────────
  //
  // 官方 .wsb schema 只定义 Networking 的两个值：Disable / Default。Default 是有意放开的
  // 攻击面（网页自动化需要它），Disable 是给「只让 agent 操作本地桌面」的人收紧用的。

  test("allowNetwork：不传 / true → Default，false → Disable", () => {
    const base = { bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out" };
    // 缺省值从 shared 的常量推，不写字面值：三处消费者（渲染层 / effectiveAllowNetwork /
    // 控制器）与它同源，改默认时这条断言跟着变，行为也就跟着变
    const expected = COMPUTER_USE_DEFAULT_ALLOW_NETWORK ? "Default" : "Disable";
    assert.ok(
      renderWsbXml(base).includes(`<Networking>${expected}</Networking>`),
      "不传时必须跟 shared 的缺省常量一致（缺省为开：默认关会让网页自动化看起来坏了）",
    );
    assert.ok(renderWsbXml({ ...base, allowNetwork: true }).includes("<Networking>Default</Networking>"));
    assert.ok(renderWsbXml({ ...base, allowNetwork: false }).includes("<Networking>Disable</Networking>"));
    assert.ok(!renderWsbXml({ ...base, allowNetwork: false }).includes("Default"), "关掉时不能留一个 Default 在文档里");
  });

  test("出网开关不动元素顺序：Networking 仍在 MemoryInMB 之前，且仍是合法 XML", () => {
    // 顺序错了 WSB 直接报「配置文件格式错误」——这是最贵的一种错（起不来才说）
    for (const allowNetwork of [true, false]) {
      const xml = renderWsbXml({ bridgeDir: "C:\\a\\bin", outputDir: "C:\\b\\out", allowNetwork });
      const networkAt = xml.indexOf("<Networking>");
      const memoryAt = xml.indexOf("<MemoryInMB>");
      const foldersAt = xml.indexOf("<MappedFolders>");
      assert.ok(networkAt > 0 && memoryAt > networkAt && foldersAt > memoryAt);
      assert.equal(mappedFolders(xml).length, 2, "开关不该影响映射条数");
      assertLegalWsb(xml);
    }
  });
});

/** 把 .wsb 里的 MappedFolder 抽成 [{host, sandbox, readOnly}]（顺序即文档顺序） */
function mappedFolders(xml: string): Array<{ host: string; sandbox: string; readOnly: string }> {
  const result: Array<{ host: string; sandbox: string; readOnly: string }> = [];
  const pattern =
    /<MappedFolder>\s*<HostFolder>([\s\S]*?)<\/HostFolder>\s*<SandboxFolder>([\s\S]*?)<\/SandboxFolder>\s*<ReadOnly>([^<]*)<\/ReadOnly>\s*<\/MappedFolder>/g;
  for (const match of xml.matchAll(pattern)) {
    result.push({ host: match[1] ?? "", sandbox: match[2] ?? "", readOnly: match[3] ?? "" });
  }
  return result;
}

function readOnlyFlags(xml: string): string[] {
  return mappedFolders(xml).map((folder) => folder.readOnly);
}

/**
 * .wsb 必须是合法 XML，不然 WindowsSandbox.exe 直接报「配置文件格式错误」——
 * 这是最贵的一种错（起不来才说，而且现场是一句报错）。这里只做结构性的检查：
 * 根元素、每个标签都闭合、每个标签名都成对，足以接住「少写一个 </ >」这类错。
 */
function assertLegalWsb(xml: string): void {
  const withoutHeader = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  assert.ok(withoutHeader.startsWith("<Configuration>"), "根元素应是 Configuration");
  assert.ok(withoutHeader.trimEnd().endsWith("</Configuration>"), "根元素应闭合");
  const stack: string[] = [];
  for (const match of withoutHeader.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing === "/") continue;
    if (closing === "/") {
      assert.equal(stack.pop(), name, `<${String(name)}> 的闭合标签对不上`);
    } else {
      stack.push(String(name));
    }
  }
  assert.deepEqual(stack, [], "有标签没有闭合");
}

// ── 打包产物映射：start() 侧的「有就映射、没有就不映射」──────────────────//
// renderWsbXml 是纯函数（上面已测）；这里测的是控制器的决定：文件系统上到底有没有产物。
// 关键约束是「没产物也不能影响启动」——映射一个不存在的目录会让整个 .wsb 失败，
// 那等于把「没出包」变成「连看一眼沙箱桌面都不行」。

describe("打包产物映射（appDir）", () => {
  const readWsb = async (harness: Harness): Promise<string> => readFile(join(harness.dir, "session.wsb"), "utf8");

  test("appDir 存在：.wsb 带第三条只读映射，并记日志说出 guest 路径", async () => {
    const appDir = await mkdtemp(join(tmpdir(), "orbita-app-dist-"));
    const harness = await makeHarness({ appDir });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      const xml = await readWsb(harness);
      assert.ok(xml.includes(`<HostFolder>${appDir}</HostFolder>`), "产物目录应被映射进去");
      assert.match(xml, /<ReadOnly>true<\/ReadOnly>/);
      assert.ok(
        harness.logs.some((line) => line.includes("打包产物已只读映射进沙箱")),
        `日志里应有映射记录：\n${harness.logs.join("\n")}`,
      );
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true }, "有产物时启动路径不受影响");
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
      await rm(appDir, { recursive: true, force: true });
    }
  });

  test("appDir 不存在：不写这条映射、不改启动结果，但日志明说没找到产物", async () => {
    // 故意给一个不存在的路径（开发机上没出包就是这个样子）。fileExists 要模拟真磁盘：
    // 只认桥 exe 与 WindowsSandbox.exe 存在，产物目录不存在——默认的 `() => true`
    // 会把这条用例变成「永远存在」，测不到闸门。
    const missingAppDir = join(tmpdir(), "orbita-definitely-not-built-xyz");
    const harness = await makeHarness({
      appDir: missingAppDir,
      fileExists: (path) => path !== missingAppDir,
    });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      const xml = await readWsb(harness);
      assert.ok(!xml.includes("orbita-definitely-not-built-xyz"), "不存在的目录不许进 .wsb");      assert.equal(xml.match(/<MappedFolder>/g)?.length, 2, "只剩桥与 out 两条映射");
      assert.ok(
        harness.logs.some((line) => line.includes("没有找到打包产物") && line.includes("dist:win")),
        `日志里应说清楚下一步：\n${harness.logs.join("\n")}`,
      );
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true }, "没产物不该挡住启动");
    } finally {
      await harness.close();
    }
  });

  test("不传 appDir（主进程的默认用法）：不出这条映射、也不报没产物", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      const xml = await readWsb(harness);
      assert.equal(xml.match(/<MappedFolder>/g)?.length, 2);
      assert.ok(!harness.logs.some((line) => line.includes("没有找到打包产物")), "没传就不要碎碎念");
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
    } finally {
      await harness.close();
    }
  });
});

// ── 出网开关：控制器在 start() 读一次、写进 .wsb ─────────────────────────
//
// renderWsbXml 是纯函数（上面已测）；这里测控制器真的把设置读进来、并且**只在启动时**
// 读一次——运行中改设置不影响已经在跑的 VM（.wsb 早已交给 WSB）。
describe("沙箱出网开关（allowNetwork）", () => {
  const readWsb = async (harness: Harness): Promise<string> => readFile(join(harness.dir, "session.wsb"), "utf8");

  test("不注入 getter（主进程之外的调用方 / 测试默认）= shared 的缺省常量", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      const expected = COMPUTER_USE_DEFAULT_ALLOW_NETWORK ? "Default" : "Disable";
      assert.ok((await readWsb(harness)).includes(`<Networking>${expected}</Networking>`));
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
    } finally {
      await harness.close();
    }
  });

  test("getter 返回 false → Disable，启动照常成功（断网不影响沙箱自身起得来）", async () => {
    const harness = await makeHarness({ allowNetwork: async () => false });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      assert.ok((await readWsb(harness)).includes("<Networking>Disable</Networking>"));
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true }, "关掉出网不该挡住启动路径");
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
    }
  });

  test("每次启动各读一次：改了设置，下一局才生效", async () => {
    let allow = false;
    const harness = await makeHarness({ allowNetwork: () => allow });
    try {
      const first = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      assert.ok((await readWsb(harness)).includes("<Networking>Disable</Networking>"));
      harness.announceBridge();
      assert.deepEqual(await first, { ok: true });

      // 运行中改设置：这一局的 .wsb 不该被重写（没有「自动重启」这回事）
      allow = true;
      assert.ok((await readWsb(harness)).includes("<Networking>Disable</Networking>"), "运行中不许改 .wsb");

      await harness.controller.stop();
      // 「宣布 off 必须有退出证据」：假进程手动发 exit（与其它 stop 用例同一个写法）
      requireProc(harness).emitExit(0);
      assert.equal(harness.controller.status().state, "off");

      const second = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[1] ?? null);
      assert.ok((await readWsb(harness)).includes("<Networking>Default</Networking>"), "下一局读新值");
      harness.announceBridge();
      assert.deepEqual(await second, { ok: true });
    } finally {
      await harness.close();
    }
  });

  test("读设置抛错：按缺省启动并留日志，不把沙箱挡在门外", async () => {
    const harness = await makeHarness({
      allowNetwork: () => {
        throw new Error("settings.json 读不动");
      },
    });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      const expected = COMPUTER_USE_DEFAULT_ALLOW_NETWORK ? "Default" : "Disable";
      assert.ok((await readWsb(harness)).includes(`<Networking>${expected}</Networking>`));
      assert.ok(
        harness.logs.some((line) => line.includes("读出网开关失败")),
        `日志里应留下原因：\n${harness.logs.join("\n")}`,
      );
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
    } finally {
      await harness.close();
    }
  });

  test("getter 悬挂：到了上限就按缺省启动，状态机不会永远停在 starting", async () => {
    // 读设置在启动路径上、且在 deadline 建立之前：没有上限的话状态机就卡死在 starting，
    // 而 UI 那边 start 的 promise 也永远不 resolve。上限把它变成「最差 2 秒后照常启动」。
    const harness = await makeHarness({
      allowNetwork: () => new Promise<boolean>(() => undefined),
      allowNetworkTimeoutMs: 30,
    });
    try {
      const startedAt = Date.now();
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null);
      assert.ok(Date.now() - startedAt < 2_000, "上限 30ms 时不该等满 2 秒");
      const expected = COMPUTER_USE_DEFAULT_ALLOW_NETWORK ? "Default" : "Disable";
      assert.ok((await readWsb(harness)).includes(`<Networking>${expected}</Networking>`));
      assert.ok(
        harness.logs.some((line) => line.includes("超过 30ms 没有返回")),
        `日志里应说明是按缺省放行的：\n${harness.logs.join("\n")}`,
      );
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true }, "悬挂不该把启动卡死");
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
    }
  });
});

// ── bridge.json 通告解析 ────────────────────────────────────────────────

describe("parseBridgeInfo / waitForBridgeInfo", () => {
  test("parse：完整通告通过；半截 / 坏 JSON / 缺 version 都回 null", () => {
    assert.deepEqual(parseBridgeInfo('{"version":"0.1.0","pid":1234}'), { version: "0.1.0", pid: 1234 });
    assert.deepEqual(parseBridgeInfo('{"version":"0.1.0"}'), { version: "0.1.0", pid: 0 });
    assert.equal(parseBridgeInfo('{"version":""}'), null);
    assert.equal(parseBridgeInfo('{"pid":42}'), null);
    assert.equal(parseBridgeInfo('{"version":"0.1'), null);
    assert.equal(parseBridgeInfo("not json"), null);
    assert.equal(parseBridgeInfo(""), null);
  });

  test("wait：文件先坏后好——坏文件不当致命，继续等到好通告", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-ready-"));
    try {
      await writeFile(join(dir, BRIDGE_INFO_FILE), '{"version":"0.1', "utf8"); // 半截
      const waitPromise = waitForBridgeInfo(dir, { timeoutMs: 2_000, intervalMs: 20 });
      await sleep(60);
      await writeFile(join(dir, BRIDGE_INFO_FILE), '{"version":"0.1.0","pid":7}', "utf8");
      const info = await waitPromise;
      assert.equal(info?.version, "0.1.0");
      assert.equal(info?.pid, 7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wait：超时抛人话；取消 resolve null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bridge-ready-"));
    try {
      await assert.rejects(waitForBridgeInfo(dir, { timeoutMs: 60, intervalMs: 10 }), /没等到 guest 桥就绪/);
      const cancelled = await waitForBridgeInfo(dir, { timeoutMs: 5_000, intervalMs: 10, isCancelled: () => true });
      assert.equal(cancelled, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 状态机 ─────────────────────────────────────────────────────────────

describe("沙箱状态机（假进程 + 真 bridge.json 通告）", () => {
  test("start → starting；桥通告后 → running", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawnedWsb[0] ?? null); // start() 内部异步：mkdir → 清旧文件 → 写 wsb → spawn
      assert.match(harness.spawnedWsb[0] ?? "", /session\.wsb$/);
      harness.announceBridge();

      assert.deepEqual(await startPromise, { ok: true });
      const running = harness.controller.status();
      assert.equal(running.state, "running");
      if (running.state === "running") {
        assert.equal(running.bridgeVersion, "test");
        assert.ok(running.startedAt > 0);
      }
      assert.deepEqual(states(harness.events), ["starting", "running"]);
      // running 期间重复 start 被拒
      assert.deepEqual(await harness.controller.start(), { ok: false, error: "沙箱已经在运行" });
    } finally {
      await harness.close();
    }
  });

  test("上一局残留的 bridge.json 会被清掉——不许捡到死人通告", async () => {    const harness = await makeHarness();
    try {
      // 预埋一份上一局的死通告
      await mkdir(join(harness.dir, "out"), { recursive: true });
      await writeFile(join(harness.dir, "out", BRIDGE_INFO_FILE), '{"version":"old","pid":1}', "utf8");
      const startPromise = harness.controller.start();
      await sleep(50); // 让 start() 先跑完清理与 spawn
      // 死通告应已被删除；此时不 announce 就不会就绪——状态应停在 starting
      assert.equal(harness.controller.status().state, "starting");
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
    }
  });

  test("等不到桥通告 → 超时 error，沙箱进程被杀；stop 从 error 复位回 off", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 150 });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没等到 guest 桥就绪/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
      assert.ok(requireProc(harness).killed, "超时后应杀掉沙箱进程");
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("通告到了但命令通道不通（ping 无应答）→ error，消息指向 ping（映射文件夹开机热身期的护栏）", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 400 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({ respond: null }); // 只通告，不应答任何命令
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /ping/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("ping 阶段中途 stop → start() 拿「已取消」", async () => {
    const harness = await makeHarness({ readyTimeoutMs: 30_000 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({ respond: null }); // ping 永远不会应答，停在握手阶段
      await sleep(200); // 等通告被消费、进入 ping
      const stopPromise = harness.controller.stop();
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /已取消/.test(result.error));
      assert.deepEqual(await stopPromise, { ok: true });
      requireProc(harness).emitExit(0);
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
    } finally {
      await harness.close();
    }
  });

  test("stop：running → stopping（杀进程）→ exit → off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge();
      await startPromise;
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.equal(harness.controller.status().state, "stopping");
      assert.ok(requireProc(harness).killed);
      requireProc(harness).emitExit(0);
      assert.deepEqual(harness.controller.status(), { state: "off" });
      assert.deepEqual(states(harness.events), ["starting", "running", "stopping", "off"]);
    } finally {
      await harness.close();
    }
  });

  test("用户自己关掉沙箱窗口：running 期间 exit → 直接 off，不报错", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge();
      await startPromise;
      requireProc(harness).emitExit(null);
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("沙箱窗口在桥就绪前被关掉 → error 并把真实原因结给 start()（不吞成「已取消」）", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50); // 等 start() 进入轮询
      requireProc(harness).emitExit(1);
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /就绪前就关闭/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("启动中途 stop：start() 立刻拿到「已取消」，exit 后收尾为 off", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50); // 等 start() 进入轮询
      const stopPromise = harness.controller.stop();
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /已取消/.test(result.error));
      assert.deepEqual(await stopPromise, { ok: true });
      requireProc(harness).emitExit(0);
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
      assert.ok(requireProc(harness).killed);
    } finally {
      await harness.close();
    }
  });

  test("guest 桥 exe 不存在 → 不 spawn、给明确错误、状态停在 off", async () => {
    const harness = await makeHarness({ fileExists: () => false });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /guest 桥不存在/.test(result.error));
      assert.deepEqual(harness.spawned, []);
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("spawn 失败（error 事件）→ error 态，错误进状态，进程不残留", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      await sleep(50);
      requireProc(harness).emitError(new Error("ENOENT"));
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /启动失败/.test(result.error));
      assert.equal(harness.controller.status().state, "error");
      // error 之后再来的 exit 不改状态（failLocal 已收口）
      requireProc(harness).emitExit(1);
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });
});

// ── 截图（renderer 手动「看一眼」）─────────────────────────────────────────

describe("手动截图", () => {
  test("不在 running → 直接拒绝", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.controller.screenshot();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没有在运行/.test(result.error));
    } finally {
      await harness.close();
    }
  });

  test("running 时经文件协议截图：base64 / 原始尺寸 / maxWidth 传递都对，文件清干净", async () => {
    const harness = await makeHarness();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  nativeWidth: 2560,
                  nativeHeight: 1440,
                  width: req.maxWidth ?? 1280,
                  height: 720,
                  jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg`,
                },
                jpg: jpegBytes,
              },
      });
      assert.deepEqual(await startPromise, { ok: true });

      const shot = await harness.controller.screenshot(640);
      assert.equal(shot.ok, true);
      if (shot.ok) {
        assert.equal(shot.jpegBase64, jpegBytes.toString("base64"));
        assert.equal(shot.width, 640, "回图尺寸（模型看到的像素）要回给调用方：坐标换算靠它");
        assert.equal(shot.height, 720);
        assert.equal(shot.nativeWidth, 2560);
        assert.equal(shot.nativeHeight, 1440);
        assert.ok(Math.abs(shot.takenAt - Date.now()) < 5_000);
      }
      const shots = harness.requests.filter((r) => r.command === "screenshot");
      assert.equal(shots[0]?.maxWidth, 640);

      // 非法 maxWidth 落回默认 1280（桥侧看到的请求字段）
      await harness.controller.screenshot(Number.NaN);
      const shotsAfter = harness.requests.filter((r) => r.command === "screenshot");
      assert.equal(shotsAfter[1]?.maxWidth, 1280);

      // 清理纪律：cmd 目录不许残留 req/resp/jpg
      const left = await readdir(join(harness.dir, "out", COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      await harness.close();
    }
  });

  test("桥死了不回 → 超时错误原话带出", async () => {
    const harness = await makeHarness({ guestTimeoutMs: 300 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge(); // 默认应答器只答 ping；截图无人应答
      await startPromise;
      const shot = await harness.controller.screenshot(1280);
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /没有响应/.test(shot.error));
    } finally {
      await harness.close();
    }
  });

  test("桥回错误响应（截图失败）→ 错误原话带出", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping" ? { resp: { ok: true } } : { resp: { ok: false, error: "截图失败：桌面会话没就绪" } },
      });
      await startPromise;
      const shot = await harness.controller.screenshot(1280);
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /桌面会话没就绪/.test(shot.error));
    } finally {
      await harness.close();
    }
  });
});



// ── 按窗口截图（win-shot / win-list，桥 0.9.0）──────────────────────────────

describe("按窗口截图", () => {
  test("不在 running → 直接拒绝（两条新命令都不例外）", async () => {
    const harness = await makeHarness();
    try {
      const shot = await harness.controller.windowShot({ hwnd: 1 });
      assert.equal(shot.ok, false);
      assert.ok(shot.ok === false && /没有在运行/.test(shot.error));
      const list = await harness.controller.listWindows();
      assert.equal(list.ok, false);
      assert.ok(list.ok === false && /没有在运行/.test(list.error));
    } finally {
      await harness.close();
    }
  });

  test("win-shot 经文件协议：hwnd / maxWidth 原样下发，回图与窗口几何一起回来，文件清干净", async () => {
    const harness = await makeHarness();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0x03, 0x04]);
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  hwnd: req.hwnd ?? 9999,
                  title: "Edge - 新建标签页",
                  restoredFromMinimized: true,
                  nativeWidth: 1600,
                  nativeHeight: 900,
                  width: 640,
                  height: 360,
                  jpeg: `cmd-${String(req.seq).padStart(6, "0")}.jpg`,
                },
                jpg: jpegBytes,
              },
      });
      assert.deepEqual(await startPromise, { ok: true });

      const shot = await harness.controller.windowShot({ hwnd: 4321, maxWidth: 640 });
      assert.equal(shot.ok, true);
      if (shot.ok) {
        assert.equal(shot.jpegBase64, jpegBytes.toString("base64"));
        assert.equal(shot.width, 640);
        assert.equal(shot.height, 360);
        // 窗口自己的物理尺寸（不是屏幕尺寸）：工具层要靠它提醒「坐标不能用于点击」
        assert.equal(shot.nativeWidth, 1600);
        assert.equal(shot.nativeHeight, 900);
        assert.equal(shot.hwnd, 4321);
        assert.equal(shot.title, "Edge - 新建标签页");
        assert.equal(shot.restoredFromMinimized, true);
      }
      const shots = harness.requests.filter((r) => r.command === "win-shot");
      assert.equal(shots[0]?.hwnd, 4321, "hwnd 要原样到桥");
      assert.equal(shots[0]?.maxWidth, 640);

      // 按标题：title 走到桥，maxWidth 落回默认 1280
      await harness.controller.windowShot({ title: " 记事本 ", hwnd: undefined });
      const byTitle = harness.requests.filter((r) => r.command === "win-shot")[1];
      assert.equal(byTitle?.title, "记事本", "标题两端空白要去掉，否则永远不会命中");
      assert.equal(byTitle?.maxWidth, 1280);
      assert.equal(byTitle?.hwnd, undefined, "没给 hwnd 就不该编一个 0 出来");

      const left = await readdir(join(harness.dir, "out", COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      await harness.close();
    }
  });

  test("win-shot 拍不到：桥那句人话原样带出（宿主不改写成「没有响应」之类）", async () => {
    const harness = await makeHarness();
    const human = "这个窗口拍不到（可能被最小化后无法恢复 / 显卡合成方式不支持按窗口截取）——改用整桌面截图或 computer_screenshot";
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) => (req.command === "ping" ? { resp: { ok: true } } : { resp: { ok: false, error: human } }),
      });
      await startPromise;
      const shot = await harness.controller.windowShot({ hwnd: 9 });
      assert.deepEqual(shot, { ok: false, error: human });
    } finally {
      await harness.close();
    }
  });

  test("win-list：windows 数组按契约解析（缺字段的条目跳过，不让半个窗口流出去）", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  windows: [
                    {
                      hwnd: 11,
                      title: "Edge",
                      process: "msedge",
                      className: "Chrome_WidgetWin_1",
                      x: 10,
                      y: 20,
                      w: 800,
                      h: 600,
                      minimized: false,
                      visible: true,
                    },
                    { hwnd: 12, title: "记事本", process: "", className: "Notepad", x: 0, y: 0, w: 400, h: 300, minimized: true, visible: true },
                    { title: "没有 hwnd 的半条记录" },
                  ],
                },
              },
      });
      await startPromise;
      const list = await harness.controller.listWindows();
      assert.equal(list.ok, true);
      if (list.ok) {
        assert.equal(list.windows.length, 2);
        assert.deepEqual(list.windows[1], {
          hwnd: 12,
          title: "记事本",
          process: "",
          className: "Notepad",
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          minimized: true,
          visible: true,
        });
      }
      const listRequests = harness.requests.filter((r) => r.command === "win-list");
      assert.equal(listRequests.length, 1);
    } finally {
      await harness.close();
    }
  });
});

// ── UIA 车道（uia-list / uia-act，桥 0.10.0）──────────────────────
//
// 控制器这一层只是字段搬运：选项 → 桥认的字段名、回执 → 带 ok 的联合类型。搬错一个字段
// 名字（action / perform、title / window）桥就不认识，模型拿到一句全指向别处的话。

describe("UIA 车道", () => {
  test("不在 running → 两条命令都直接拒绝（不白等 45 秒）", async () => {
    const harness = await makeHarness();
    try {
      const list = await harness.controller.uiaList({ hwnd: 1 });
      assert.equal(list.ok, false);
      assert.ok(list.ok === false && /没有在运行/.test(list.error));
      const act = await harness.controller.uiaAct({ hwnd: 1, ref: 1, perform: "invoke" });
      assert.equal(act.ok, false);
      assert.ok(act.ok === false && /没有在运行/.test(act.error));
    } finally {
      await harness.close();
    }
  });

  test("uia-list 经文件协议：hwnd / maxItems 原样下发，标题去空白，回执按契约带回", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  hwnd: 4321,
                  window: { title: "记事本", className: "Notepad" },
                  items: [
                    {
                      ref: 1,
                      name: "文本编辑器",
                      controlType: "document",
                      automationId: "15",
                      className: "Edit",
                      x: 10,
                      y: 40,
                      w: 700,
                      h: 500,
                      patterns: ["value"],
                      enabled: true,
                      offscreen: false,
                    },
                  ],
                  truncated: false,
                },
              },
      });
      await startPromise;

      const byHwnd = await harness.controller.uiaList({ hwnd: 4321, maxItems: 60 });
      assert.equal(byHwnd.ok, true);
      if (byHwnd.ok) {
        assert.equal(byHwnd.hwnd, 4321);
        assert.equal(byHwnd.items[0]?.controlType, "document");
        assert.deepEqual(byHwnd.items[0]?.patterns, ["value"]);
        assert.equal(byHwnd.truncated, false);
      }
      const requests = harness.requests.filter((r) => r.command === "uia-list");
      assert.equal(requests[0]?.hwnd, 4321);
      assert.equal(requests[0]?.maxItems, 60);
      assert.equal(requests[0]?.title, undefined, "没给 title 就不该编一个空串出来");

      await harness.controller.uiaList({ title: " 记事 " });
      const byTitle = harness.requests.filter((r) => r.command === "uia-list")[1];
      assert.equal(byTitle?.title, "记事", "标题两端空白要去掉，否则永远匹配不上");
      assert.equal(byTitle?.hwnd, undefined);
      assert.equal(byTitle?.maxItems, undefined, "没给 maxItems 就吃桥的缺省值");
    } finally {
      await harness.close();
    }
  });

  test("uia-act：perform → action、ref / name / value / timeoutMs 原样下发；autoSetFocus 的降级原因带回", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : {
                resp: {
                  ok: true,
                  hwnd: req.hwnd ?? 9,
                  action: req.action ?? "setValue",
                  usedPattern: "value",
                  name: "搜索",
                  controlType: "edit",
                  focused: false,
                  autoSetFocus: false,
                  autoSetFocusWarning: "AutoSetFocus 关不掉——可能抢焦点",
                  elapsedMs: 17,
                },
              },
      });
      await startPromise;

      const reply = await harness.controller.uiaAct({
        hwnd: 9,
        perform: "setValue",
        name: "搜索",
        value: "orbita",
        timeoutMs: 1500,
      });
      assert.equal(reply.ok, true);
      if (reply.ok) {
        assert.equal(reply.action, "setValue");
        assert.equal(reply.usedPattern, "value");
        assert.equal(reply.autoSetFocus, false);
        assert.match(reply.autoSetFocusWarning ?? "", /可能抢焦点/);
        assert.equal(reply.elapsedMs, 17);
      }
      const request = harness.requests.find((r) => r.command === "uia-act");
      assert.equal(request?.action, "setValue", "契约里的 perform 在桥上叫 action");
      assert.equal(request?.hwnd, 9);
      assert.equal(request?.name, "搜索");
      assert.equal(request?.value, "orbita");
      assert.equal(request?.timeoutMs, 1500);
      assert.equal(request?.ref, undefined);
    } finally {
      await harness.close();
    }
  });

  test("uia-act 失败：桥的人话原样带出（不支持模式时点名它支持什么）", async () => {
    const harness = await makeHarness();
    const human = "这个控件不支持 invoke（edit，它支持：value）——改用 computer_click / computer_type 的像素路径";
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) => (req.command === "ping" ? { resp: { ok: true } } : { resp: { ok: false, error: human } }),
      });
      await startPromise;
      assert.deepEqual(await harness.controller.uiaAct({ hwnd: 1, ref: 3, perform: "invoke" }), {
        ok: false,
        error: human,
      });
    } finally {
      await harness.close();
    }
  });
});

// ── 平台闸门 ──
//
// （历史：这里曾有「junction 末段名带空格 / cmd 特殊字符就拦住」的闸门——映射落点靠宿主
// 目录名派生时才有必要。现在落点由 .wsb 的 <SandboxFolder> 写死，宿主路径不再进命令串，
// 该闸门与它的测试一并删掉：它能拦的只剩下「连接了不存在的坏路径」这类误报。）

// ── stop 的收尾链：宣布 off 必须有退出证据（2026-10-14 真机咬两次）──────────
//
// 原来的 3 秒兜底定时器直接宣布 off，而 taskkill 可能没杀成 / 只杀掉了 launcher：
// UI 显示「未启动」，宿主却留着 ~2GB 的孤儿 VM（第二次得按 PID 手动清）。
// 现在：kill → 等退出（exit 事件 / exitCode 轮询，二者取先到）→ 还没退就升级一次
// 按 PID 杀进程树 → 再等一个窗口仍不退才 off，并留下「进程可能未退出」的痕迹。

describe("平台闸门", () => {
  test("start：非 win32 → 只报平台那一条，不 spawn、不落 .wsb、状态停在 off（macOS 验收）", async () => {
    const harness = await makeHarness({ platform: "darwin" });
    try {
      const result = await harness.controller.start();
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && result.error.includes("只在 Windows"), result.ok ? "" : result.error);
      // 不能报「先运行 bun run build:bridge」那类误导文案
      assert.ok(result.ok === false && !result.error.includes("build:bridge"), result.ok ? "" : result.error);
      assert.deepEqual(harness.spawned, [], "平台不对，不该起沙箱进程");
      assert.equal(existsSync(join(harness.dir, "session.wsb")), false, "不该落 .wsb");
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });
});

describe("stop 的收尾链", () => {
  /** 起一局并进入 running（三例共用） */
  const startRunning = async (harness: Harness): Promise<FakeSandboxProcess> => {
    const startPromise = harness.controller.start();
    harness.announceBridge();
    assert.deepEqual(await startPromise, { ok: true });
    return requireProc(harness);
  };

  test("① 正常退出：退出事件即确认，off；兜底与升级都不发生", async () => {
    const escalated: number[] = [];
    const harness = await makeHarness({
      killTreeByPid: (pid) => escalated.push(pid),
      killFallbackMs: 30,
      killEscalationMs: 30,
    });
    try {
      const proc = await startRunning(harness);
      assert.deepEqual(await harness.controller.stop(), { ok: true });
      assert.equal(harness.controller.status().state, "stopping", "stop() 回执只说这次调用，状态听推送");
      assert.equal(proc.killCount, 1, "第一次 kill 照常发");

      proc.emitExit(0);
      assert.deepEqual(harness.controller.status(), { state: "off" });
      // 两个窗口都过完之后也不许再有杀动作（定时器该被清掉）
      await sleep(150);
      assert.deepEqual(escalated, [], "确认退出之后不许升级杀");
      assert.equal(proc.killCount, 1);
      assert.deepEqual(harness.logs.filter((line) => /升级/.test(line)), []);
    } finally {
      await harness.close();
    }
  });

  test("② 永不退出：升级一次按 PID 杀进程树；仍不退才 off，且留下痕迹（不静默）", async () => {
    const escalated: number[] = [];
    const harness = await makeHarness({
      killTreeByPid: (pid) => escalated.push(pid),
      killFallbackMs: 30,
      killEscalationMs: 40,
    });
    try {
      const proc = await startRunning(harness);
      await harness.controller.stop();
      // 兜底窗口（30ms）→ 升级 → 升级窗口（40ms）→ off
      await waitFor(() => (harness.controller.status().state === "off" ? true : null), 2_000);
      assert.deepEqual(escalated, [4242], "兜底窗口到点应按 PID 升级杀一次");
      assert.ok(harness.logs.some((line) => /升级/.test(line)), harness.logs.join("\n"));
      assert.ok(harness.logs.some((line) => /仍未退出/.test(line)), harness.logs.join("\n"));
      assert.ok(harness.logs.some((line) => /手动结束/.test(line)), "痕迹要带上「怎么收拾」");
      assert.equal(proc.killCount, 1, "升级走的是 killTreeByPid，不再调 child.kill()");
      // 收尾之后不再有新的杀动作
      await sleep(100);
      assert.equal(escalated.length, 1);
    } finally {
      await harness.close();
    }
  });

  test("③ 没接升级杀（无 pid / 无注入点）→ 退回再调一次 child.kill()", async () => {
    const harness = await makeHarness({ killFallbackMs: 30, killEscalationMs: 30 });
    try {
      const proc = await startRunning(harness);
      await harness.controller.stop();
      await waitFor(() => (proc.killCount >= 2 ? true : null), 2_000);
      assert.equal(proc.killCount, 2, "第一次 kill + 升级时再调一次");
    } finally {
      await harness.close();
    }
  });
});

// ── 2026-10-23 Windows 更新后的新沙箱架构 ─────────────────────────────────
//
// 真机取证（秒级采样）：`WindowsSandbox.exe` 只是启动器——spawn 后 **0 秒就以 code 0 退出**，
// 把 VM 交给 `WindowsSandboxServer`（`WindowsSandboxClient` 时代结束）。旧代码把「child 退出」
// 当成「窗口被用户关了」，于是三处一起坏：
//   ① starting 阶段明明起得来的沙箱被判 error；
//   ② running 阶段再也没有「用户关窗」信号（这条不在本组测试的范围内）；
//   ③ stop 时 child 已经是 null → 没有 PID 可杀 → 留下 ~2.5GB 的 VM。
// 对策：① 启动器 code 0 / null 只记一笔、继续等桥；③ 启动前记沙箱侧进程基线，stop 时按
// 「现在有、基线里没有」的差集收，收尾仍要有退出证据（沿用 2026-10-14 的纪律）。

describe("新沙箱架构：启动器退出与基线差集收尾", () => {
  test("① starting 阶段启动器 exit 0 → 不失败，桥随后就绪 → running", async () => {
    const harness = await makeHarness({ listSandboxProcesses: () => [] });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawned[0] ?? null);
      // 新架构的现实：启动器 0 秒退出，桥还在正常启动
      requireProc(harness).emitExit(0);
      await sleep(20);
      assert.equal(harness.controller.status().state, "starting", "启动器退出不该被当成窗口被关");
      assert.ok(
        harness.logs.some((line) => /启动器已退出/.test(line)),
        `应留下一笔「启动器退出、由 Server 接管」的日志：${harness.logs.join(" | ")}`,
      );

      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });
      assert.equal(harness.controller.status().state, "running");
    } finally {
      await harness.close();
    }
  });

  test("② starting 阶段启动器 exit 非 0 → 仍是真失败（原话带出）", async () => {
    const harness = await makeHarness({ listSandboxProcesses: () => [] });
    try {
      const startPromise = harness.controller.start();
      await sleep(50);
      requireProc(harness).emitExit(3);
      const result = await startPromise;
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /就绪前就关闭了（exit code 3）/.test(result.error), result.ok ? "" : result.error);
      assert.equal(harness.controller.status().state, "error");
    } finally {
      await harness.close();
    }
  });

  test("③ stop 且 child 已为 null：只杀基线之外的新 PID，全部消失才 off", async () => {
    // 基线 = 别人的沙箱 / 上一局的残留；这只沙箱起来后多出 4100 / 4101
    let alive: SandboxProcessInfo[] = [{ image: "vmwp.exe", pid: 1000 }];
    const killed: number[] = [];
    const harness = await makeHarness({
      killFallbackMs: 60,
      killEscalationMs: 60,
      listSandboxProcesses: () => alive,
      killTreeByPid: (pid) => {
        killed.push(pid);
        alive = alive.filter((current) => current.pid !== pid);
      },
    });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawned[0] ?? null);
      // 启动器把 VM 拉起来之后，沙箱侧才出现这两个
      alive = [
        { image: "vmwp.exe", pid: 1000 },
        { image: "WindowsSandboxServer.exe", pid: 4100 },
        { image: "WindowsSandboxRemoteSessi", pid: 4101 },
      ];
      requireProc(harness).emitExit(0); // 新架构：启动器立刻走了，于是 stop 时 child 为 null
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });

      assert.deepEqual(await harness.controller.stop(), { ok: true });
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
      assert.deepEqual(killed, [4100, 4101], "只杀我们这只沙箱新起的两个，基线里的 1000 不许碰");
      assert.deepEqual(harness.controller.status(), { state: "off" });
    } finally {
      await harness.close();
    }
  });

  test("④ stop 且 PID 一直不消失：升级再杀一次 → 留痕 → off", async () => {
    let alive: SandboxProcessInfo[] = [{ image: "vmwp.exe", pid: 1000 }];
    const killed: number[] = [];
    const harness = await makeHarness({
      killFallbackMs: 40,
      killEscalationMs: 40,
      listSandboxProcesses: () => alive, // 装死：taskkill 打不动
      killTreeByPid: (pid) => killed.push(pid),
    });
    try {
      const startPromise = harness.controller.start();
      await waitFor(() => harness.spawned[0] ?? null);
      alive = [
        { image: "vmwp.exe", pid: 1000 },
        { image: "WindowsSandboxServer.exe", pid: 4100 },
      ];
      requireProc(harness).emitExit(0);
      harness.announceBridge();
      assert.deepEqual(await startPromise, { ok: true });

      await harness.controller.stop();
      await waitFor(() => (harness.controller.status().state === "off" ? true : null), 3_000);
      assert.deepEqual(killed, [4100, 4100], "兜底窗口没消失 → 升级再杀一次");
      assert.ok(
        harness.logs.some((line) => /可能未退出/.test(line)),
        `收尾要留痕，不能静默 off：${harness.logs.join(" | ")}`,
      );
      assert.ok(harness.logs.some((line) => /手动结束/.test(line)), "痕迹要带上「怎么收拾」");
    } finally {
      await harness.close();
    }
  });
});

// ── 优雅关窗（2026-10-23 真机验收补的一层）─────────────────────────────────
//
// 强杀能杀掉 Server / RemoteSession，**但 VM 不退**：vmwp.exe + vmmemWindowsSandbox
// （3.4GB）继续占着，vmwp 自己 taskkill 还是拒绝访问。等于「关窗但泄漏 VM」。
// 正确收尾是关掉 RemoteSession 的窗口（等价用户点 X）**并替他按下沙箱自己的确认框**：
// 只发 WM_CLOSE 会停在「Are you sure…? [Ok] [Cancel]」上没人按，真机 9~12 秒是把 Ok 按下去
// 之后的数字。所以 stopOrphans 的第一级是优雅关窗（含确认），强杀只是退路。

describe("graceful close：先关窗，关不掉才强杀", () => {
  /** 起一局，启动器 0 秒退出，沙箱侧出现 Server + RemoteSession + vmwp 三个进程 */
  const startNewArch = async (
    harness: Harness,
    onSpawned: () => void,
  ): Promise<void> => {
    const startPromise = harness.controller.start();
    await waitFor(() => harness.spawned[0] ?? null);
    onSpawned();
    requireProc(harness).emitExit(0);
    harness.announceBridge();
    assert.deepEqual(await startPromise, { ok: true });
  };

  test("① 有 RemoteSession：先关窗（含确认框 Ok），PID 优雅消失后不再强杀", async () => {
    const closed: number[] = [];
    const killed: number[] = [];
    let alive: SandboxProcessInfo[] = [{ image: "vmwp.exe", pid: 1000 }];
    const harness = await makeHarness({
      killFallbackMs: 60,
      killEscalationMs: 60,
      gracefulCloseMs: 200,
      listSandboxProcesses: () => alive,
      closeSandboxWindow: (pid) => {
        closed.push(pid);
        // 真机语义：关窗后整条链自己退（这里立刻模拟，省时间）
        alive = [{ image: "vmwp.exe", pid: 1000 }];
      },
      killTreeByPid: (pid) => killed.push(pid),
    });
    try {
      await startNewArch(harness, () => {
        alive = [
          { image: "vmwp.exe", pid: 1000 },
          { image: "WindowsSandboxServer.exe", pid: 4200 },
          { image: "WindowsSandboxRemoteSession.exe", pid: 4300 },
        ];
      });

      assert.deepEqual(await harness.controller.stop(), { ok: true });
      await waitFor(() => (harness.controller.status().state === "off" ? true : null));
      assert.deepEqual(closed, [4300], "关窗只发给 RemoteSession（窗口进程），不发 Server / vmwp");
      assert.deepEqual(killed, [], "优雅关窗生效后不许再强杀——强杀会把 VM 留给宿主");
      assert.ok(harness.logs.some((line) => /关闭沙箱窗口/.test(line)), harness.logs.join(" | "));
    } finally {
      await harness.close();
    }
  });

  test("② 关了窗但 PID 不消失 → 退回强杀升级链，最后留痕 off", async () => {
    const closed: number[] = [];
    const killed: number[] = [];
    let alive: SandboxProcessInfo[] = [{ image: "vmwp.exe", pid: 1000 }];
    const harness = await makeHarness({
      killFallbackMs: 40,
      killEscalationMs: 40,
      gracefulCloseMs: 40,
      listSandboxProcesses: () => alive, // 装死：窗口不理会关窗确认，taskkill 也打不动
      closeSandboxWindow: (pid) => closed.push(pid),
      killTreeByPid: (pid) => killed.push(pid),
    });
    try {
      await startNewArch(harness, () => {
        alive = [
          { image: "vmwp.exe", pid: 1000 },
          { image: "WindowsSandboxRemoteSession.exe", pid: 4300 },
        ];
      });

      await harness.controller.stop();
      await waitFor(() => (harness.controller.status().state === "off" ? true : null), 3_000);
      assert.deepEqual(closed, [4300]);
      assert.deepEqual(killed, [4300, 4300], "优雅关闭没生效 → 兜底强杀 + 升级再杀一次");
      assert.ok(harness.logs.some((line) => /退回强杀/.test(line)), harness.logs.join(" | "));
      assert.ok(harness.logs.some((line) => /可能未退出/.test(line)), "最终仍要留痕，不静默");
    } finally {
      await harness.close();
    }
  });
});

// ── agent 工具的 guest 命令下发（PR2：click / type / key / scroll）────────────

describe("guest 命令下发", () => {
  /** 把桥看到的请求收窄成 Record，断言字段用 */
  const fieldsOf = (harness: Harness, index: number): Record<string, unknown> =>
    harness.requests[index] as unknown as Record<string, unknown>;

  test("不在 running → 直接拒绝（消息里带“去哪儿启动”），一个 req 都不落盘", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.controller.guestCommand("click", { x: 1, y: 2 });
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没有在运行/.test(result.error));
      assert.ok(result.ok === false && /设置 › 实验功能 › 电脑使用/.test(result.error));
      assert.deepEqual(harness.requests, [], "闸门在写文件之前，不该有任何请求");
    } finally {
      await harness.close();
    }
  });

  test("running 时经文件协议下发：命令名与字段原样到桥，req/resp 清干净", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      // 所有命令都答 ok（含 ping）；默认应答器只答 ping，装死会让 click 等到超时
      harness.announceBridge({ respond: () => ({ resp: { ok: true } }) });
      await startPromise;

      assert.deepEqual(
        await harness.controller.guestCommand("click", { x: 100, y: 200, button: "right", double: true }),
        { ok: true },
      );
      assert.deepEqual(
        await harness.controller.guestCommand("type", { text: "你好" }),
        { ok: true },
      );
      assert.deepEqual(await harness.controller.guestCommand("key", { key: "alt+f4" }), { ok: true });
      assert.deepEqual(await harness.controller.guestCommand("scroll", { x: 5, y: 6, deltaY: -120 }), { ok: true });

      const commands = harness.requests.slice(1).map((req) => req.command);
      assert.deepEqual(commands, ["click", "type", "key", "scroll"]);
      // 序号从 1 起：start() 把上一局的序号归零，桥的快路径（直探 cmd-000001）第一条即命中
      assert.deepEqual(harness.requests.map((req) => req.seq), [1, 2, 3, 4, 5]);
      assert.deepEqual(fieldsOf(harness, 1), {
        seq: 2,
        command: "click",
        x: 100,
        y: 200,
        button: "right",
        double: true,
      });
      assert.deepEqual(fieldsOf(harness, 2), { seq: 3, command: "type", text: "你好" });
      assert.deepEqual(fieldsOf(harness, 3), { seq: 4, command: "key", key: "alt+f4" });
      assert.deepEqual(fieldsOf(harness, 4), { seq: 5, command: "scroll", x: 5, y: 6, deltaY: -120 });

      const left = await readdir(join(harness.dir, "out", COMPUTER_USE_CMD_DIR));
      assert.deepEqual(left, [], `应清理干净，实际残留：${left.join(", ")}`);
    } finally {
      await harness.close();
    }
  });

  test("桥回错误响应（不认识的键名）→ 原话带出", async () => {
    const harness = await makeHarness();
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge({
        respond: (req) =>
          req.command === "ping"
            ? { resp: { ok: true } }
            : { resp: { ok: false, error: "不认识的按键名：hyper" } },
      });
      await startPromise;
      const result = await harness.controller.guestCommand("key", { key: "hyper+x" });
      assert.deepEqual(result, { ok: false, error: "不认识的按键名：hyper" });
    } finally {
      await harness.close();
    }
  });

  test("桥死了不回 → 超时错误原话带出", async () => {
    const harness = await makeHarness({ guestTimeoutMs: 300 });
    try {
      const startPromise = harness.controller.start();
      harness.announceBridge(); // 默认应答器只答 ping
      await startPromise;
      const result = await harness.controller.guestCommand("click", { x: 1, y: 2 });
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && /没有响应/.test(result.error));
    } finally {
      await harness.close();
    }
  });
});
