/**
 * 零依赖 CDP 客户端——**每一步都有时限，超时就报出卡在哪一步并退出**。
 *
 * 为什么要有它：agent 临时写的 CDP 脚本反复出现「没响应」——fetch 没超时、WebSocket
 * 连不上不报、`Runtime.evaluate` 等一个永不 resolve 的 promise、窗口被遮挡时
 * `Page.captureScreenshot` 永不返回。脚本不退出，bash 就一直挂着，看起来像 agent 卡死，
 * 用户与 agent 都不知道该等还是该停（2026-10-02/03 并行验收反复踩）。
 * 这里把三条兜底做成默认值，ui-smoke 与临时验收脚本都从这里连：
 * 1. 每条命令都有时限（默认 10 秒），超时的错误里写着方法名；
 * 2. 全局看门狗（默认 90 秒）到点打印最后一步并 exit 2——bash 一定会返回；
 * 3. 每步打印带耗时的进度行，输出停在哪一行就是卡在哪一步。
 *
 * 用法（临时脚本放会话工作台，import 用绝对路径）：
 *   import { connectCdp } from "<仓库>/scripts/cdp.mjs";
 *   const cdp = await connectCdp({ cdpPort: 9334, devPort: 5274 });
 *   await cdp.evaluate("document.title");
 *   await cdp.screenshot("/tmp/shot.png");
 *   cdp.close();
 */
import { writeFileSync } from "node:fs";

const startedAt = Date.now();
let lastStep = "（尚未开始）";

/** 打印一行进度并记作「最后一步」：看门狗触发时报的就是它 */
export function step(name) {
  lastStep = name;
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${name}`);
}

/** 到点强制退出：脚本自己保证会结束，不靠调用方记得加 timeout（macOS 没有 timeout 命令） */
export function watchdog(ms) {
  const timer = setTimeout(() => {
    console.error(`✖ 看门狗：${ms / 1000} 秒内没跑完，停在「${lastStep}」。退出，不再等。`);
    process.exit(2);
  }, ms);
  timer.unref();
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms / 1000} 秒没有响应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 连上应用页面。devPort 用来认页面：只连 URL 含 `127.0.0.1:<devPort>` 的 target，
 * 连到别的实例（另一个 worktree / 别的 electron 应用）当场失败，而不是对着它验收一轮。
 */
export async function connectCdp({ cdpPort, devPort, commandTimeoutMs = 10_000, watchdogMs = 90_000 }) {
  watchdog(watchdogMs);
  const http = `http://127.0.0.1:${cdpPort}`;

  step(`连 CDP ${http}`);
  let targets;
  try {
    targets = await withTimeout(fetch(`${http}/json/list`).then((r) => r.json()), 3_000, "GET /json/list");
  } catch (error) {
    console.error(`✖ 连不上 ${http}（${error.message}）——应用是否带 --remote-debugging-port=${cdpPort} 启动？`);
    console.error("  端口本身也可能被 Windows 保留段吞掉（bind 静默失败），换一个段外的：");
    console.error("  netsh interface ipv4 show excludedportrange protocol=tcp");
    process.exit(1);
  }

  const marker = `127.0.0.1:${devPort}`;
  const page = targets.find((t) => t.type === "page" && t.url.includes(marker));
  if (!page) {
    console.error(`✖ 这个 CDP 端口上没有 ${marker} 的页面——连到的不是你要验的那个实例。当前 targets：`);
    for (const t of targets) console.error(`  [${t.type}] ${t.url}`);
    process.exit(1);
  }

  step("打开 WebSocket");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(
    new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    }),
    5_000,
    "WebSocket 握手",
  );

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    entry.resolve(message);
  };
  // 连接断了，在途的命令全部失败——不然它们会一直等到看门狗
  ws.onclose = () => {
    for (const entry of pending.values()) entry.reject(new Error("CDP 连接已断开（应用退出或重载？）"));
    pending.clear();
  };

  const send = (method, params = {}, timeoutMs = commandTimeoutMs) => {
    const id = ++seq;
    const reply = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    return withTimeout(reply, timeoutMs, method).finally(() => pending.delete(id));
  };

  /** 在页面里执行表达式，返回可序列化值；页面异常原样抛出 */
  const evaluate = async (expression, timeoutMs) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (response.error !== undefined) throw new Error(response.error.message);
    const details = response.result?.exceptionDetails;
    if (details !== undefined) throw new Error(details.exception?.description ?? "页面内异常");
    return response.result?.result?.value;
  };

  /**
   * 截图。先置前 + 模拟焦点：窗口被遮挡 / 最小化时 captureScreenshot 可能永不返回。
   * 仍然超时就别重试了——改用 evaluate 取 DOM / 几何作证据。
   */
  const screenshot = async (path) => {
    step(`截图 → ${path}`);
    await send("Page.bringToFront");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const response = await send("Page.captureScreenshot", { format: "png" }, 15_000);
    writeFileSync(path, Buffer.from(response.result.data, "base64"));
  };

  return { send, evaluate, screenshot, close: () => ws.close() };
}
