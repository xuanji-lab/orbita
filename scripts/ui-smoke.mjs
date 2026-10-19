/**
 * UI 冒烟验收（A-7）——零依赖 CDP 驱动**真实应用**。
 *
 * 为什么是 CDP 而不是组件测试：hook 层的 bug（sessionRef 置空、setStates 滞后、
 * draggable 吞 click——9-12 三次返工全是这类）静态读不出、组件测试也未必复现，
 * 只有驱动真应用才验得住。方法论来自 9-12 的返工排查，这里固化成仓内脚本。
 *
 * 用法：
 *   1. 带调试端口启动应用（electron-vite 把 `--` 之后的参数透传给 Electron）：
 *        bun run dev -- --remote-debugging-port=9333
 *        ORBITA_DEV_INSTANCE=accept ORBITA_DEV_PORT=5310 bun run dev -- --remote-debugging-port=39334   # 第二实例，dev 端口 5310
 *   2. 另开终端：
 *        bun scripts/ui-smoke.mjs [CDP 端口] [dev 端口]
 *      CDP 端口默认 9333；dev 端口默认读 ORBITA_DEV_PORT、再默认 5273——它用来认页面，
 *      验隔离实例（设了 ORBITA_DEV_PORT）时传对应端口。
 *      CDP 端口只在连不上时才需要换：Windows 的保留端口段会静默吞掉 bind
 *      （应用起得来、端口就是不通），先查表换一个落在段外的：
 *        netsh interface ipv4 show excludedportrange protocol=tcp
 *      （2026-10-03 实测：9333 正落在 9274–9373 保留段里，排查了整个下午）
 *
 * 通过 = exit 0；任何一项红灯 = exit 1 并列出失败项；超时 = exit 2 并报出卡在哪一步。
 * 冒烟只断言**任何分支都成立**的最小集合（挂载 / 主入口 / 设置面），
 * 不写与特定功能耦合的断言——那是各刀自己的验收清单的事。
 */
import { connectCdp, step } from "./cdp.mjs";

const cdpPort = process.argv[2] ?? "9333";
const devPort = process.argv[3] ?? process.env.ORBITA_DEV_PORT ?? "5273";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "✓" : "✖"} ${name}${ok ? "" : ` — ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { evaluate, close } = await connectCdp({ cdpPort, devPort, watchdogMs: 60_000 });

// —— 冒烟项 ——

// 1. renderer 挂载：#root 里有内容（空 = 白屏，什么都别说别的了）
step("检查 renderer 挂载");
check("renderer 已挂载（#root 非空）", (await evaluate(`document.querySelector("#root")?.children.length > 0`)) === true);

// 2. 主操作入口：New task / 新任务 按钮（accent 主操作，任何形态都在）。
//    中英两种界面都认：开发版数据目录里语言设成中文时，只认英文会误报。
//    形态两种都认：方案 B v2（2026-10-19）起它是工具栏左胶囊里的图标键，
//    文本为空、全名在 title / aria-label 上——所以除了 textContent 还要测这两处。
step("检查主操作入口");
check(
  "主操作入口存在（New task / 新任务）",
  (await evaluate(`[...document.querySelectorAll("button")].some((b) => /New task|新任务/.test(b.textContent) || ["New task", "新任务"].includes(b.title) || ["New task", "新任务"].includes(b.getAttribute("aria-label")))`)) === true,
);

// 3. 设置面可打开：点侧栏的 Settings（展开态是文字 NavRow，收起态是 title 方块），
//    主题档位行出现。Settings 按钮是开关：上一次冒烟留下的设置面会被这一点关掉，
//    所以已开着就先点一下关上，再从关闭态打开——结果不取决于应用当前停在哪
const clickSettings = () =>
  evaluate(
    `[...document.querySelectorAll("button")].find((b) => ["Settings", "设置"].some((s) => b.title === s || b.textContent.trim() === s))?.click()`,
  );
const settingsVisible = () => evaluate(`/Theme|主题/.test(document.body.innerText)`);
if ((await settingsVisible()) === true) {
  step("设置面已开着，先关上");
  await clickSettings();
  await sleep(400);
}
step("打开设置面");
await clickSettings();
await sleep(400);
check(
  "设置面可打开（Theme / 主题 行可见）",
  (await settingsVisible()) === true,
);

const failed = checks.filter((item) => !item.ok).length;
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）` : `\n${failed} / ${checks.length} 项失败`);
close();
process.exit(failed === 0 ? 0 : 1);
