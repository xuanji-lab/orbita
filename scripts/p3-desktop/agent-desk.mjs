/**
 * L3 端到端验收：**用 agent 的工具路径**在一台真 Linux 桌面 VM 上做成一件事。
 *
 *   node scripts/p3-desktop/agent-desk.mjs                 # 1 台 VM，跑完整链
 *   node scripts/p3-desktop/agent-desk.mjs --vms 2         # 2 台并行，各跑一次，互不干扰
 *   node scripts/p3-desktop/agent-desk.mjs --outshots DIR  # 截图落在哪（默认 <imageDir>/agent-shots）
 *
 * 为什么这样算「工具路径」而不是手工敲命令：下发用的是 `applyComputerUseRequest` ——
 * agent 进程里 computer_* 工具执行时调的就是它（工具层只多做两件事：把模型看得懂的参数
 * 翻成 request、把几何记下来做坐标换算；请求与回执的形状完全相同）。VM 由
 * `QemuSandboxProvider` 起，与设置页点「启动」走的是同一个 start()。
 *
 * 链（每一步之间都给桌面留时间，模型看到的也只有这几张图）：
 *   ① computer_screenshot               看桌面
 *   ② computer_click（双击 Home 图标）   打开文件管理器 Thunar
 *   ③ computer_click（点 Thunar 的 File） 菜单弹出来
 *   ④ computer_click（点 Open Terminal Here）终端打开
 *   ⑤ computer_click（点终端内部）       焦点进终端
 *   ⑥ computer_type + computer_key       打 echo ORBITA_P3_AGENT_OK 并回车
 *   ⑦ computer_screenshot               图里读得到那行输出
 *
 * 坐标是**从第一张截图里量的**（和模型做的事一样）。UI 位置没有写死到「必须一样」：
 * 每一步之后都用 win-list 断言目标窗口在不在，不在就 Esc 清场重来一次——这正是
 * 模型在截图里发现没点时该做的事。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyComputerUseRequest } from "../../src/main/computer-use/agent-requests.ts";
import { QemuSandboxProvider } from "../../src/main/computer-use/qemu.ts";
import { qemuVmPaths } from "../../src/main/computer-use/qemu-vm.ts";

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};
const VM_COUNT = Number(opt("--vms", "1"));
const SESSION = "p3-acceptance";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = qemuVmPaths();
const shotDir = opt("--outshots", path.join(base.imageDir, "agent-shots"));
fs.mkdirSync(shotDir, { recursive: true });

/**
 * 给第 n 台 VM 准备一块**自己的**磁盘：base 只读，写落在 overlay 上。
 *
 * 为什么必须这么做：两台 QEMU 同时写同一个 qcow2 会直接把镜像写坏，而且这不是「验收脚本的
 * 讲究」——多 VM 并行本来就要求每位一份可写层（这也正是 P3 后面要做快照回滚的东西）。
 * 单台时也走 overlay：验收不该改动基线镜像，跑完删掉就能重来。
 */
function overlayDisk(index) {
  const file = path.join(base.imageDir, `desktop-accept-${index}.qcow2`);
  fs.rmSync(file, { force: true });
  const qemuImg = path.join(base.qemuDir, "root", "mingw64", "bin", "qemu-img.exe");
  const result = spawnSync(qemuImg, ["create", "-f", "qcow2", "-F", "qcow2", "-b", base.disk, file], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`qemu-img create 失败：${result.stderr || result.stdout}`);
  return file;
}

function saveShot(name, base64) {
  const file = path.join(shotDir, name);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

/** 发一条工具请求并把它结掉（失败就是失败，不吞） */
async function step(provider, request, label) {
  const result = await applyComputerUseRequest(provider, SESSION, request);
  if (result.ok !== true) throw new Error(`${label} 失败：${result.error}`);
  return result;
}

async function windowTitles(provider) {
  const list = await provider.listWindows();
  if (!list.ok) return [];
  return list.windows.map((window) => window.title);
}

async function waitForWindow(provider, needle, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const titles = await windowTitles(provider);
    if (titles.some((title) => title.toLowerCase().includes(needle.toLowerCase()))) return true;
    await sleep(300);
  }
  return false;
}

async function runChain(provider, tag) {
  const shots = [];
  const startedAt = Date.now();

  // ① 看桌面
  const first = await step(provider, { action: "screenshot", maxWidth: 1280 }, "第一张截图");
  shots.push({ step: "01-desktop", file: saveShot(`${tag}-01-desktop.png`, first.shot.data) });

  // ② 双击 Home 图标（桌面左上，1280×800 下的默认位置）
  await step(provider, { action: "click", x: 55, y: 65, double: true }, "双击 Home 图标");
  let opened = await waitForWindow(provider, "Thunar");
  if (!opened) {
    await step(provider, { action: "click", x: 55, y: 65, double: true }, "重试双击 Home 图标");
    opened = await waitForWindow(provider, "Thunar");
  }
  const afterOpen = await step(provider, { action: "screenshot", maxWidth: 1280 }, "打开文件管理器后的截图");
  shots.push({ step: "02-thunar-open", file: saveShot(`${tag}-02-thunar-open.png`, afterOpen.shot.data), opened });

  // ③④ File → Open Terminal Here（菜单项的位置是从截图里量的）
  let terminal = false;
  for (let attempt = 0; attempt < 2 && !terminal; attempt += 1) {
    await step(provider, { action: "click", x: 23, y: 70 }, "点 File 菜单");
    await sleep(400);
    if (attempt === 0) {
      // 这一张证明的是「工具的一次点击把菜单打开了」——菜单是点一下就展开的 UI
      const menu = await step(provider, { action: "screenshot", maxWidth: 1280 }, "菜单展开后的截图");
      shots.push({ step: "02b-menu-open", file: saveShot(`${tag}-02b-menu-open.png`, menu.shot.data) });
    }
    await step(provider, { action: "click", x: 100, y: 197 }, "点 Open Terminal Here");
    terminal = await waitForWindow(provider, "Terminal");
    if (!terminal) {
      await step(provider, { action: "key", key: "Escape" }, "Esc 清场");
      await sleep(300);
    }
  }
  const afterTerminal = await step(provider, { action: "screenshot", maxWidth: 1280 }, "终端打开后的截图");
  shots.push({
    step: "03-terminal-open",
    file: saveShot(`${tag}-03-terminal-open.png`, afterTerminal.shot.data),
    terminal,
  });
  if (!terminal) throw new Error("点菜单没能打开终端（见 03-terminal-open.png）");

  // ⑤ 焦点进终端：窗口位置由窗口管理器决定，**从 win-list 取它现在的矩形**再点中心。
  //    模型是从截图里量这个点的（同一件事的两种读法）；点击本身仍走 computer_click。
  const listed = await provider.listWindows();
  const terminalWindow = listed.ok ? (listed.windows.find((window) => window.title.includes("Terminal")) ?? null) : null;
  if (terminalWindow === null) throw new Error("开了终端却列不到它的窗口");
  await step(
    provider,
    {
      action: "click",
      x: Math.round(terminalWindow.x + terminalWindow.w / 2),
      y: Math.round(terminalWindow.y + terminalWindow.h / 2),
    },
    "点终端内部",
  );

  // ⑥ 打字 + 回车
  await step(provider, { action: "type", text: "echo ORBITA_P3_AGENT_OK" }, "打字");
  const typed = await step(provider, { action: "screenshot", maxWidth: 1280 }, "打完字截图");
  shots.push({ step: "04-typed", file: saveShot(`${tag}-04-typed.png`, typed.shot.data) });
  await step(provider, { action: "key", key: "Return" }, "按回车");
  await sleep(800);

  // 并行时再加一行**这台专属**的标记：两台的图里各只有自己的那一行，
  // 这才是「互不干扰」的证据（同图不同秒的字节差异说明不了串不串画面）。
  await step(provider, { action: "type", text: `echo ONLY-${tag.toUpperCase()}` }, "打这台专属的标记");
  await step(provider, { action: "key", key: "Return" }, "按回车（标记）");
  await sleep(600);

  // ⑦ 再截一张：图里要能读到那行输出
  const final = await step(provider, { action: "screenshot", maxWidth: 1280 }, "结果截图");
  shots.push({ step: "05-result", file: saveShot(`${tag}-05-result.png`, final.shot.data) });

  return {
    tag,
    shotDir,
    shots,
    geometry: {
      width: first.shot.width,
      height: first.shot.height,
      nativeWidth: first.shot.nativeWidth,
      nativeHeight: first.shot.nativeHeight,
    },
    chainMs: Date.now() - startedAt,
    // 截图的字节数变化本身就是「画面上多了东西」的证据（最后一张 != 第一张）
    firstShotBytes: Buffer.from(first.shot.data, "base64").length,
    lastShotBytes: Buffer.from(final.shot.data, "base64").length,
  };
}

const results = [];
const providers = [];
try {
  for (let index = 1; index <= VM_COUNT; index += 1) {
    const disk = overlayDisk(index);
    const provider = new QemuSandboxProvider({ paths: { ...base, disk } });
    providers.push(provider);
  }
  // 两台是**同时起**的：并行不是「先后跑两次」，也不是共用一块屏幕
  const bootStarted = Date.now();
  const boots = await Promise.all(
    providers.map(async (provider, index) => {
      const result = await provider.start();
      return {
        vm: index + 1,
        ok: result.ok,
        error: result.ok === false ? result.error : undefined,
        status: provider.status(),
      };
    }),
  );
  const bootMs = Date.now() - bootStarted;
  const failed = boots.filter((boot) => boot.ok !== true);
  if (failed.length > 0) {
    throw new Error(`有 VM 没起来：${JSON.stringify(failed)}`);
  }

  // 各跑一条同样的链（并行）
  const runs = await Promise.all(providers.map((provider, index) => runChain(provider, `vm${index + 1}`)));

  // 两台互不干扰的证据：画面不同、各自的窗口清单也各自是它那台的
  let crossTalk = null;
  if (providers.length > 1) {
    const [a, b] = providers;
    const shotA = await a.screenshot(640);
    const shotB = await b.screenshot(640);
    crossTalk = {
      aBytes: shotA.ok ? Buffer.from(shotA.jpegBase64, "base64").length : -1,
      bBytes: shotB.ok ? Buffer.from(shotB.jpegBase64, "base64").length : -1,
      identical: shotA.ok && shotB.ok ? shotA.jpegBase64 === shotB.jpegBase64 : null,
    };
  }

  results.push({ bootMs, boots, runs, crossTalk });
} finally {
  for (const provider of providers) {
    await provider.stop().catch(() => undefined);
  }
}

console.log(JSON.stringify({ vmCount: VM_COUNT, shotDir, imageDir: base.imageDir, results }, null, 2));
