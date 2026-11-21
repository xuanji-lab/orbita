/**
 * 生产 renderer 同源预览的真实窗口验收。Electron 与无头 Chrome 共用这一份脚本。
 *
 * 先起隔离实例，例如：
 *   ORBITA_DEV_INSTANCE=designpreview ORBITA_DEV_PORT=5810 bun run dev -- --remote-debugging-port=39810
 * 再运行：
 *   bun scripts/ui-preview.mjs 39810 5810 /tmp/orbita-preview-shots
 *
 * 无头 Chrome 只需用同一个 dev URL 和另一个 CDP 端口启动，脚本参数不变。
 * 输出覆盖首页、Boss、子会话回父、普通 Session、右栏、两档设置、用量格、空与满载。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectCdp, step } from "./cdp.mjs";

const cdpPort = process.argv[2] ?? "39810";
const devPort = process.argv[3] ?? process.env.ORBITA_DEV_PORT ?? "5810";
const outArg = process.argv[4];
if (outArg === undefined || outArg === "") {
  console.error("用法：bun scripts/ui-preview.mjs [CDP端口] [dev端口] <截图目录>");
  process.exit(1);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const base = `http://127.0.0.1:${devPort}/preview.html`;
const checks = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "✓" : "✖"} ${name}${ok ? "" : ` — ${detail}`}`);
};

const { send, evaluate, close } = await connectCdp({ cdpPort, devPort, watchdogMs: 180_000 });

async function waitFor(expression, label, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    if ((await evaluate(expression)) === true) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

async function clickText(text, scope = "button") {
  const expression = `(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(scope)})]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if ((await evaluate(expression)) !== true) throw new Error(`找不到可点击文字：${text}（${scope}）`);
  await sleep(220);
}

async function clickAria(label) {
  const expression = `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if ((await evaluate(expression)) !== true) throw new Error(`找不到按钮：${label}`);
  await sleep(220);
}

async function navigate(scene, theme = "light") {
  step(`打开 ${scene} / ${theme}`);
  await send("Page.navigate", { url: `${base}?scene=${scene}&theme=${theme}&lang=en` });
  await waitFor(`document.querySelector(".app-shell") !== null && document.documentElement.dataset.previewScene === ${JSON.stringify(scene)}`, `${scene} 挂载`);
  await sleep(650);
}

async function shot(name) {
  await sleep(180);
  const path = resolve(outDir, `${name}.png`);
  step(`截图 → ${path}`);
  // 已在脚本开头模拟焦点；这里不能调用通用 helper 的 Page.bringToFront——它会触发
  // mouseleave，把刚验过的 usage hover 清掉，拍到的就不是断言时的那一帧。
  const response = await send("Page.captureScreenshot", { format: "png" }, 15_000);
  writeFileSync(path, Buffer.from(response.result.data, "base64"));
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  // 先聚焦再 hover： UsageMeter 的全局失焦规则会暂停入场动画；若等 screenshot 才聚焦，
  // 气泡会停在 opacity:0 的第一帧，DOM 断言虽绿、截图却看不到。
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // 同源预览要可重复：关闭装饰动效，避免截图恰好落在透明或位移的入场帧。
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__previewErrors = [];
      window.addEventListener("error", (event) => window.__previewErrors.push(String(event.error || event.message)));
      window.addEventListener("unhandledrejection", (event) => window.__previewErrors.push(String(event.reason)));`,
  });

  await navigate("typical");
  check(
    "生产壳与关键组件同源挂载",
    (await evaluate(`[".toolbar", ".sidebar", ".right-rail", "textarea.composer-input", ".usage-meter"].every((selector) => document.querySelector(selector) !== null)`)) === true,
  );
  check("首页读取 fixture 最近记录", (await evaluate(`document.body.innerText.includes("Refine the session navigation")`)) === true);
  await shot("01-typical-home-light");

  step("工作区 → Boss");
  await clickText("Research atlas", ".workspace-group button");
  await waitFor(`document.querySelector("textarea.composer-input")?.placeholder.includes("Hand it something") === true`, "Boss 转录");
  check("Boss 真实转录已加载", (await evaluate(`document.body.innerText.includes("Map the current work")`)) === true);
  await shot("02-typical-boss-light");

  step("主智能体左侧只露工作区：当前工作区下面没有子行，也没有侧栏顶的「等你」");
  check(
    "侧栏只露工作区行",
    (await evaluate(`document.querySelectorAll(".workspace-group .tree-children").length === 0 && document.querySelector(".sidebar .attention") === null`)) === true,
  );

  step("主智能体 → 进度「等你」→ 子 Session → 面包屑回父");
  await clickAria("This task");
  await waitFor(`document.querySelector(".tp-waiting") !== null`, "进度面板最前的「等你」");
  check(
    "进度按 等你 → 各件活 的顺序",
    (await evaluate(`(() => { const heads = [...document.querySelectorAll(".tp-sec > .tp-gh")].map((item) => item.firstChild?.textContent?.trim()); return heads.indexOf("Waiting on you") === 0 && heads.includes("Work items"); })()`)) === true,
  );
  await shot("02b-typical-main-progress-light");
  await clickText("Compare session navigation", ".tp-waiting .tp-job-name");
  await waitFor(`[...document.querySelectorAll(".cap-sess button")].some((item) => item.textContent?.trim() === "Research atlas")`, "父会话面包屑");
  check("子 Session 真实转录已加载", (await evaluate(`document.body.innerText.includes("Replacing the main conversation")`)) === true);
  await shot("03-typical-child-light");
  await clickText("Research atlas", ".cap-sess button");
  await waitFor(`document.querySelector("textarea.composer-input")?.placeholder.includes("Hand it something") === true`, "返回 Boss");
  check("回父恢复主智能体输入面", true);
  await waitFor(`document.querySelector(".tp-waiting") !== null`, "回父后进度面板按会话记忆恢复");
  check("回父后右栏进度照旧开着", true);
  await clickAria("This task");
  await waitFor(`document.querySelector(".right-panel-slot.open") === null`, "右栏关闭");

  step("普通 Session");
  await clickText("Refine the session navigation", ".sidebar button");
  await waitFor(`document.body.innerText.includes("The existing parent and child conversation path is sufficient.")`, "普通 Session 转录");
  check("普通 Session 与 Boss 共用 ChatView", (await evaluate(`document.querySelector("textarea.composer-input")?.placeholder === "Reply, or steer the agent"`)) === true);
  await shot("04-typical-session-light");

  step("右栏打开、页签切换、关闭");
  await clickAria("This task");
  await waitFor(`document.querySelector(".right-panel-slot.open") !== null`, "右栏打开");
  await clickText("Context", '[role="tab"]');
  check("右栏上下文页签真实选中", (await evaluate(`[...document.querySelectorAll('[role="tab"]')].some((item) => item.textContent?.trim() === "Context" && item.getAttribute("aria-selected") === "true")`)) === true);
  await shot("05-typical-context-light");
  await clickAria("This task");
  await waitFor(`document.querySelector(".right-panel-slot.open") === null`, "右栏关闭");
  check("右栏关闭", true);

  step("设置：通用与模型服务");
  await clickAria("Settings");
  await waitFor(`document.body.innerText.includes("Appearance") && document.body.innerText.includes("Software update")`, "通用设置");
  check("通用设置使用 fixture 设置与更新快照", (await evaluate(`document.body.innerText.includes("0.1.19")`)) === true);
  await shot("06-settings-general-light");
  await clickText("Providers", ".sidebar button");
  await waitFor(`document.querySelector(".pv-wall") !== null`, "模型服务卡片墙");
  check("模型服务真实卡片与目录加载", (await evaluate(`document.body.innerText.includes("Kimi K3.1 Pro") && document.body.innerText.includes("Price · capability")`)) === true);
  await shot("07-settings-providers-light");
  await clickAria("Settings");

  step("用量格：真实鼠标 hover 与钉日期");
  const point = await evaluate(`(() => {
    const cell = document.querySelectorAll(".usage-cell")[2];
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (point === null) throw new Error("找不到第三个用量格");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await waitFor(`document.querySelector(".usage-say")?.innerText.includes("180k") === true`, "用量 hover 明细");
  check("hover 显示分型号明细", (await evaluate(`document.querySelector(".usage-say")?.innerText.includes("Kimi K3.1 Pro") === true`)) === true);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await waitFor(`document.querySelectorAll(".usage-cell")[2]?.dataset.pinned === "true"`, "钉住用量日期");
  check("钉日期写入真实组件状态", true);
  // Electron 的 captureScreenshot 会清掉 React hover（已实测 before/after），不同宿主不能都
  // 依赖 hover 截图；hover 用上面的 DOM 与明细断言验收，这里只保证拍钉日期态。
  await shot("08-usage-pinned-light");

  await navigate("empty");
  check("空场景没有工作区与旧任务", (await evaluate(`document.querySelectorAll(".workspace-group").length === 0 && !document.body.innerText.includes("Refine the session navigation")`)) === true);
  await shot("09-empty-home-light");

  await navigate("full", "black");
  check("满载场景渲染 12 个工作区", (await evaluate(`document.querySelectorAll(".workspace-group").length === 12`)) === true);
  check("玄主题与满载 fixture 同时生效", (await evaluate(`document.documentElement.dataset.theme === "black" && document.documentElement.dataset.previewScene === "full"`)) === true);
  await shot("10-full-home-onyx");

  const errors = await evaluate(`window.__previewErrors ?? []`);
  check("窗口没有未捕获异常或未处理 Promise rejection", Array.isArray(errors) && errors.length === 0, JSON.stringify(errors));
} catch (error) {
  check("CDP 验收脚本完成", false, error instanceof Error ? error.message : String(error));
} finally {
  close();
}

const failed = checks.filter((item) => !item.ok).length;
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）；截图：${outDir}` : `\n${failed} / ${checks.length} 项失败；截图：${outDir}`);
process.exit(failed === 0 ? 0 : 1);
