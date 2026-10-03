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
 *   2. 另开终端：
 *        bun scripts/ui-smoke.mjs [端口]
 *      端口默认 9333，只在连不上时才需要换：Windows 的保留端口段会静默吞掉 bind
 *      （应用起得来、端口就是不通），先查表换一个落在段外的：
 *        netsh interface ipv4 show excludedportrange protocol=tcp
 *      （2026-10-03 实测：9333 正落在 9274–9373 保留段里，排查了整个下午）
 *
 * 通过 = exit 0；任何一项红灯 = exit 1 并列出失败项。
 * 冒烟只断言**任何分支都成立**的最小集合（挂载 / 主入口 / 设置面），
 * 不写与特定功能耦合的断言——那是各刀自己的验收清单的事。
 */
// CDP 端口可用第一个参数覆盖（默认 9333）：保留段按机器动态变化，写死哪个都可能撞
const cdpPort = process.argv[2] ?? "9333";
const CDP_HTTP = `http://127.0.0.1:${cdpPort}`;
const DEV_SERVER_URL = "127.0.0.1:5273";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "✓" : "✖"} ${name}${ok ? "" : ` — ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// —— 连 CDP：找 renderer 的页面 target ——
let targets;
try {
  targets = await fetch(`${CDP_HTTP}/json/list`).then((response) => response.json());
} catch {
  console.error(`✖ 连不上 ${CDP_HTTP}——应用是否带 --remote-debugging-port=${cdpPort} 启动？`);
  console.error("  端口本身也可能被 Windows 保留段吞掉（bind 静默失败），换一个段外的：");
  console.error("  netsh interface ipv4 show excludedportrange protocol=tcp");
  process.exit(1);
}
const page = targets.find(
  (target) => target.type === "page" && target.url.includes(DEV_SERVER_URL),
);
if (!page) {
  console.error("✖ 找不到应用页面 target。当前 targets：");
  for (const target of targets) console.error(`  [${target.type}] ${target.url}`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("WebSocket 连接失败"));
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

/** 在页面里执行表达式。表达式应返回可序列化值；页面异常会原样抛出。 */
async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.error !== undefined) throw new Error(response.error.message);
  const details = response.result?.exceptionDetails;
  if (details !== undefined) {
    throw new Error(details.exception?.description ?? "页面内异常");
  }
  return response.result?.result?.value;
}

// —— 冒烟项 ——

// 1. renderer 挂载：#root 里有内容（空 = 白屏，什么都别说别的了）
check("renderer 已挂载（#root 非空）", (await evaluate(`document.querySelector("#root")?.children.length > 0`)) === true);

// 2. 主操作入口：New task 按钮（accent 主操作，任何形态都在）
check(
  "主操作入口存在（New task）",
  (await evaluate(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("New task"))`)) === true,
);

// 3. 设置面可打开：点侧栏的 Settings（展开态是文字 NavRow，收起态是 title 方块），
//    主题档位行出现
await evaluate(
  `[...document.querySelectorAll("button")].find((b) => b.title === "Settings" || b.textContent.trim() === "Settings")?.click()`,
);
await sleep(400);
check(
  "设置面可打开（Theme 行可见）",
  (await evaluate(`document.body.innerText.includes("Theme")`)) === true,
);

const failed = checks.filter((item) => !item.ok).length;
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）` : `\n${failed} / ${checks.length} 项失败`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
