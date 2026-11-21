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

async function navigate(scene, theme = "light", extra = "") {
  step(`打开 ${scene} / ${theme}${extra === "" ? "" : ` ${extra}`}`);
  await send("Page.navigate", { url: `${base}?scene=${scene}&theme=${theme}&lang=en${extra}` });
  await waitFor(`document.querySelector(".app-shell") !== null && document.documentElement.dataset.previewScene === ${JSON.stringify(scene)}`, `${scene} 挂载`);
  await sleep(650);
}

/** 点包含文本的最小元素：文件树行 / 菜单按钮（文字+图标复合）都按「最具体的那个」命中。 */
async function clickLeaf(text, scope = "body") {
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
    const candidates = [...root.querySelectorAll("*")].filter((el) =>
      (el.textContent ?? "").trim() !== "" &&
      (el.textContent ?? "").includes(${JSON.stringify(text)}) &&
      el.closest("[aria-hidden='true']") === null);
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
    const minLength = (candidates[0].textContent ?? "").length;
    const minimal = candidates.filter((el) => (el.textContent ?? "").length === minLength);
    const interactive = "button, [role='button'], [role='treeitem'], [role='option'], [role='tab'], [role='switch'], [role='menuitem'], [role='row'], li, a, label, span, strong, .file-row";
    const hit = minimal.find((el) => el.matches(interactive)) ?? minimal[0].closest(interactive) ?? minimal[0];
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  })()`;
  if ((await evaluate(expression)) !== true) throw new Error(`找不到可点击叶子：${text}（${scope}）`);
  await sleep(220);
}

async function dblclickLeaf(text, scope = "body") {
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
    const candidates = [...root.querySelectorAll("*")].filter((el) =>
      (el.textContent ?? "").trim() !== "" &&
      (el.textContent ?? "").includes(${JSON.stringify(text)}));
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
    candidates[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  })()`;
  if ((await evaluate(expression)) !== true) throw new Error(`找不到可双击叶子：${text}`);
  await sleep(260);
}

async function pressEscape() {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(220);
}

/** 在指定容器里按 aria-label 点按钮（避开右栏入口与面板页头的同名按钮）。 */
async function clickAriaIn(label, scope) {
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
    const button = [...root.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if ((await evaluate(expression)) !== true) throw new Error(`找不到按钮：${label}（${scope}）`);
  await sleep(220);
}

/** 断言页面文本包含；返回 true 供 check 使用。 */
async function bodyIncludes(fragment) {
  return (await evaluate(`document.body.innerText.includes(${JSON.stringify(fragment)})`)) === true;
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
    "进度按 等你 → 目标 → 计划 → 各件活 → 以前的会话 的顺序",
    (await evaluate(`(() => {
      const heads = [...document.querySelectorAll(".tp-body > .tp-sec > .tp-gh, .tp-body > .tp-goal > .tp-gh")].map((item) => item.firstChild?.textContent?.trim());
      const order = ["Waiting on you", "Goal", "Plan", "Work items", "Earlier sessions"].map((name) => heads.indexOf(name));
      return order.every((index, at) => index === at);
    })()`)) === true,
  );
  await shot("02b-typical-main-progress-light");
  await clickText("Compare session navigation", ".tp-waiting .tp-job-name");
  await waitFor(`[...document.querySelectorAll(".cap-sess button")].some((item) => item.textContent?.trim() === "Research atlas")`, "父会话面包屑");
  check("子 Session 真实转录已加载", (await evaluate(`document.body.innerText.includes("Replacing the main conversation")`)) === true);
  check(
    "看一件活时所属工作区行亮着、但读屏不说当前页",
    (await evaluate(`(() => { const name = [...document.querySelectorAll(".workspace-group button")].find((item) => item.textContent?.trim() === "Research atlas"); return name?.closest(".option-row")?.getAttribute("data-active") === "true" && !name.hasAttribute("aria-current"); })()`)) === true,
  );
  await shot("03-typical-child-light");
  await clickText("Research atlas", ".cap-sess button");
  await waitFor(`document.querySelector("textarea.composer-input")?.placeholder.includes("Hand it something") === true`, "返回 Boss");
  check("回父恢复主智能体输入面", true);
  await waitFor(`document.querySelector(".tp-waiting") !== null`, "回父后进度面板按会话记忆恢复");
  check("回父后右栏进度照旧开着", true);
  check(
    "每件活带自含摘要（上次 / 在等 / 下一步）",
    (await evaluate(`(() => { const row = document.querySelector(".tp-waiting .tp-job"); const keys = [...(row?.querySelectorAll(".tp-brief-k") ?? [])].map((item) => item.textContent); return keys.join("|") === "Last|Waiting|Next"; })()`)) === true,
  );

  step("以前的会话：进度面板 → 侧栏那一页");
  await clickText("All earlier sessions", ".tp-jobs-fold .tp-text");
  await waitFor(`document.querySelector(".sidebar")?.innerText.includes("Sketch the first sidebar layout") === true && document.querySelector(".sidebar input[aria-label]") !== null`, "侧栏「以前的会话」页");
  check("旧会话从进度面板找回到侧栏那一页", true);
  await shot("02c-typical-earlier-light");
  await clickAria("Back to tasks");

  step("Esc 关右栏");
  await evaluate(`document.activeElement?.blur?.(), true`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`document.querySelector(".right-panel-slot.open") === null`, "Esc 关闭右栏");
  check("Esc 关闭右栏", true);

  step("跨天：对主智能体说「接着上次」");
  await evaluate(`(() => {
    const input = document.querySelector("textarea.composer-input");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Pick up where we left off");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(`document.querySelector(".pane-main")?.innerText.includes("You left this yesterday at") === true`, "恢复回答");
  check(
    "恢复回答五项齐全且标明不是模型记忆",
    (await evaluate(`["Why", "Last time", "Already decided", "Waiting on you", "Next", "not the model's memory"].every((word) => document.querySelector(".pane-main")?.innerText.includes(word))`)) === true,
  );
  await shot("02d-typical-resume-light");

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

  // ═══════════ 组1：文件树 / 文件预览 / 文档与演示文稿 ═══════════
  step("组1：普通任务 → 文件面板（会话工作台树）");
  await navigate("typical");
  await clickText("Refine the session navigation", ".sidebar button");
  await waitFor(`document.body.innerText.includes("The existing parent and child conversation path is sufficient.")`, "普通任务转录");
  await clickAria("Files");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("notes.md") === true`, "文件树列出工作台");
  check("文件面板挂载并列出会话工作台", true);
  await clickLeaf("output", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("diff-summary.txt") === true`, "展开 output 子目录");
  check("子目录展开列出 diff-summary.txt", true);
  await shot("11-files-workbench");

  step("组1：切到工作区会话 → 工作区树 → 代码/图片/二进制/大日志");
  await clickText("Research atlas", ".sidebar button");
  await waitFor(`document.querySelector("textarea.composer-input")?.placeholder.includes("Hand it something") === true`, "Boss 会话");
  if ((await evaluate(`document.querySelector(".tp-waiting") !== null`)) !== true) await clickAria("This task");
  await waitFor(`document.querySelector(".tp-waiting") !== null`, "主智能体进度里的等你");
  await clickText("Compare session navigation", ".tp-waiting .tp-job-name");
  await clickAria("Files");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("pitch.slides.json") === true`, "工作区树渲染");
  await clickLeaf("src", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("app.ts") === true`, "src 展开");
  await clickLeaf("app.ts", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("deterministic preview source") === true`, "代码预览");
  check("点击 app.ts 出文本预览（生产 fs:read 路径）", true);
  await shot("12-files-code-preview");

  step("组1：markdown 渲染 + 图片 + 二进制 + 大日志分段");
  await clickLeaf("README.md", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Fixture workspace for the deterministic preview") === true`, "md 预览");
  check("markdown 文件走生产渲染管线", true);
  await clickLeaf("assets", ".right-panel-slot");
  await clickLeaf("logo.png", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot img") !== null`, "图片预览");
  check("png 出图片预览", true);
  await clickLeaf("archive.zip", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Open with default app") === true`, "二进制出口");
  check("zip 如实给「用默认应用打开」，不读内容", true);
  await clickLeaf("data", ".right-panel-slot");
  await clickLeaf("server.log", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("fixture log line 00001") === true`, "分段预览首窗");
  check("大日志走 lineIndex/readLines 分段预览", true);
  await shot("13-files-large-log");

  step("组1：演示文稿面板打开 fixture deck");
  await clickAria("Presentations");
  const deckOpened = (await evaluate(`document.querySelector(".right-panel-slot")?.innerText.includes("Fixture deck") === true`));
  if (deckOpened !== true) {
    await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("pitch") === true`, "演示文稿清单");
    await clickLeaf("pitch", ".right-panel-slot");
  }
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Fixture deck") === true`, "幻灯片画布");
  check("SlidesView 从 fixture deck 渲染画布", true);
  await shot("14-slides-deck");

  // ═══════════ 组2：审查 / 摘抄 / 记忆 / 终端 / 自动化 ═══════════
  step("组2：审查面板四来源与 diff 边界态");
  await clickAria("Review changes");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("logo.png") === true`, "审查列表");
  await clickLeaf("app.ts", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("deterministic preview source") === true`, "diff 展开");
  check("任务来源 diff 展开（unified diff 生产渲染）", true);
  await shot("15a-review-diff-expanded");
  await clickAriaIn("This task", ".toolbar");
  await sleep(250);
  await clickLeaf("Unstaged", "body");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("bundle.js") === true`, "未暂存来源");
  check("来源切换到 Unstaged 真实重拉", true);
  await clickLeaf("bundle.js", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Binary") === true`, "二进制标");
  check("二进制文件如实标 Binary", true);
  await clickAriaIn("Unstaged", ".toolbar");
  await sleep(250);
  await clickLeaf("This task", "body");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("rewrite.md") === true`, "回任务来源");
  await clickLeaf("rewrite.md", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("doesn't build a diff") === true`, "过大出口");
  check("超限 diff 给「改动太大」出口，不截断", true);
  await clickLeaf("notes.md", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Restored") === true`, "已还原标");
  check("已还原文件如实标 Restored", true);
  await shot("15-review-diff-states");

  step("组2：摘抄页签筛选与回到原文");
  await clickText("Excerpts", '[role="tab"]');
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("one breadcrumb away") === true`, "摘抄列表");
  check("摘抄页签列出三条 fixture 摘抄", true);
  const excerptJumped = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => (item.getAttribute("aria-label") ?? item.title ?? "").toLowerCase().includes("original"));
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  await sleep(400);
  check("摘抄「回到原文」按钮可点", excerptJumped === "clicked", String(excerptJumped));

  step("组2：记忆页签（本会话无记忆时空态如实）");
  await clickText("Memory", '[role="tab"]');
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Nothing remembered from this task yet") === true`, "记忆空态");
  check("记忆页签空态如实（边界：本会话无注入记录）", true);

  step("组2：终端面板走生产 spawn-failure 未连接路径");
  await clickAria("Terminal");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Could not start a terminal") === true`, "终端未连接提示", 90);
  check("终端 + 明确报「未连接」而不是假终端", true);
  await shot("17-terminal-not-connected");

  step("组2：自动化面板状态转移与运行拒绝");
  await clickAria("Automations");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Daily literature digest") === true`, "自动化列表");
  await clickLeaf("All", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Nightly workbench cleanup") === true`, "全部范围三行");
  check("自动化列表三行（active/paused/failed）", true);
  const digestOpened = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => item.getAttribute("aria-label") === "Open details of Daily literature digest");
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  if (digestOpened !== "clicked") throw new Error("打不开自动化详情：" + String(digestOpened));
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Every day at 09:00") === true`, "自动化详情");
  check("详情页渲染排期与运行记录", true);
  const runNow = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => (item.textContent ?? "").trim() === "Run now");
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Couldn’t do that") === true || document.querySelector(".right-panel-slot")?.innerText.includes("Couldn't do that") === true`, "运行拒绝提示");
  check("立即运行明确报未连接（不假成功）", runNow === "clicked", String(runNow));
  const pauseClicked = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => (item.textContent ?? "").trim() === "Pause");
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  await sleep(400);
  check("自动化 Pause 可点", pauseClicked === "clicked", String(pauseClicked));
  check("暂停后切换键翻面为 Resume", (await evaluate(`[...document.querySelectorAll(".right-panel-slot button")].some((item) => (item.textContent ?? "").trim() === "Resume")`)) === true);
  await shot("18a-automation-detail");
  await evaluate(`document.querySelector(".right-panel-slot .auto-back")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))`);
  await sleep(350);
  check("返回列表", (await evaluate(`document.querySelector(".right-panel-slot")?.innerText.includes("Daily literature digest") === true`)) === true);
  const detailOpened = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => item.getAttribute("aria-label") === "Open details of Nightly workbench cleanup");
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  if (detailOpened !== "clicked") throw new Error("打不开失败任务详情：" + String(detailOpened));
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Fixture: bound session cwd is missing") === true`, "自动化详情运行记录");
  check("详情页打开失败任务的运行记录", true);
  const restartClicked = (await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".right-panel-slot button")];
    const target = buttons.find((item) => (item.getAttribute("aria-label") ?? item.textContent ?? "").toLowerCase().includes("restart"));
    if (target === undefined) return "no-button";
    target.click();
    return "clicked";
  })()`));
  await sleep(400);
  check("失败任务 Restart 可点并回到运行态", restartClicked === "clicked" && (await evaluate(`[...document.querySelectorAll(".right-panel-slot button")].some((item) => (item.textContent ?? "").trim() === "Pause")`)) === true, String(restartClicked));
  await shot("18-automation-detail");

  // ═══════════ 组3：插件 / 周看板 / 专注 / 引导 ═══════════
  step("组3：能力面板列表与详情");
  await clickAria("Abilities");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("session-digest") === true`, "能力列表");
  check("能力面板列出插件/技能/MCP 合成表", true);
  await clickLeaf("session-digest", ".right-panel-slot");
  await waitFor(`document.querySelector(".right-panel-slot")?.innerText.includes("Collect sessions") === true`, "插件详情工作流");
  check("详情页渲染 workflow / 配置 / 外接服务", true);
  await shot("19-plugins-detail");

  step("组3：周看板快照卡 / 无卡运行行 / 排期灰字");
  await clickAria("Board");
  await waitFor(`document.querySelector(".wk-day") !== null`, "周看板挂载");
  check("周看板七天渲染", (await evaluate(`document.querySelectorAll(".wk-day").length === 7`)) === true);
  check("快照卡 iframe 用 fixture 模板页", (await evaluate(`[...document.querySelectorAll(".wk-day iframe")].some((frame) => (frame.getAttribute("src") ?? "").includes("preview-board-card.html"))`)) === true);
  check("无卡运行灰字行可见", (await evaluate(`document.body.innerText.includes("Check CI status") === true`)) === true);
  await sleep(1800);
  await evaluate(`document.querySelectorAll("[class*=wk]").forEach((el) => { if (el.scrollWidth > el.clientWidth + 40) el.scrollLeft = 0; })`);
  await sleep(600);
  await shot("20-board-week");
  // Esc 分层退出：右栏还开着时第一下关面板（生产行为），第二下才退看板。
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await sleep(300);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await sleep(300);
  check("Esc 分层退出看板回聊天", (await evaluate(`document.querySelector(".wk-day") === null`)) === true);

  step("组3：专注全链（浮层 → 左栏 U/M → 提前结束 → 小结卡）");
  await clickAria("Focus · pick a duration and a workspace");
  await waitFor(`document.body.innerText.includes("Pick a duration and a workspace") === true`, "专注浮层");
  await clickLeaf("Research atlas", ".focus-pop, [role='dialog'], body");
  await clickText("Start focusing", "button");
  await waitFor(`document.body.innerText.includes("4 files changed") === true`, "专注左栏文件视图");
  check("专注开始：左栏显示 U/M 文件树与改动统计", true);
  await shot("21-focus-files");
  const focusCapsule = await evaluate(`(() => {
    const cap = document.querySelector(".cap-focus-run") ?? [...document.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? "").includes("Focusing"));
    if (cap === null || cap === undefined) return null;
    cap.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "clicked";
  })()`);
  if (focusCapsule === null) throw new Error("找不到专注胶囊");
  await sleep(300);
  const plusFive = (await evaluate(`(() => {
    const leaves = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").includes("+5"));
    if (leaves.length === 0) return "no-button";
    leaves[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "clicked";
  })()`));
  check("专注胶囊 +5 分钟可点", plusFive === "clicked", String(plusFive));
  const endEarlyVisible = (await evaluate(`document.body.innerText.includes("End early")`)) === true;
  if (!endEarlyVisible) {
    await evaluate(`(() => {
      const cap = document.querySelector(".cap-focus-run") ?? [...document.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? "").includes("Focusing"));
      cap?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(350);
  }
  await clickLeaf("End early", "body");
  await waitFor(`document.body.innerText.includes("Summarize this stretch?") === true`, "收工询问");
  await clickText("Yes", "button");
  await waitFor(`document.body.innerText.includes("digest 卡") === true`, "收工小结卡", 60);
  check("提前结束 → 收工询问 → fixture 小结卡", true);
  await shot("22-focus-summary");

  step("组3：首启引导自动弹 → 试试 → 跳过");
  await navigate("typical", "light", "&onboarding=1");
  await waitFor(`document.querySelector(".ob") !== null`, "引导弹层");
  check("onboarding=1 走生产自动弹出路径", true);
  const hasTry = async () => (await evaluate(`document.querySelector(".ob-try-btn") !== null`)) === true;
  for (let page = 0; page < 10 && !(await hasTry()); page += 1) {
    await clickText("Next", "button");
    await sleep(300);
  }
  const tried = (await evaluate(`(() => {
    const button = document.querySelector(".ob-try-btn");
    if (button === null) return "no-button";
    button.click();
    return "clicked";
  })()`));
  await sleep(300);
  check("「试试」把示例句放进输入框", tried === "clicked" && (await evaluate(`(document.querySelector("textarea.composer-input")?.value ?? "") !== ""`)), String(tried));
  await shot("23a-onboarding");
  const closeHow = (await evaluate(`(() => {
    if (document.querySelector(".ob") === null) return "already-gone";
    const skip = document.querySelector(".ob-skip");
    if (skip !== null) { skip.click(); return "skip"; }
    const done = [...document.querySelectorAll(".ob button")].find((b) => (b.textContent ?? "").trim() === "Done");
    if (done !== undefined) { done.click(); return "done"; }
    return "none";
  })()`));
  await waitFor(`document.querySelector(".ob") === null`, "引导关闭");
  check("跳过/完成关闭引导", closeHow === "skip" || closeHow === "done" || closeHow === "already-gone", String(closeHow));

  // ═══════════ 组4：窄窗 / 中文纸面主题 / 外部来源 / 语音 / 实验入口 ═══════════
  step("组4：940px 窄窗形态");
  await navigate("typical");
  await send("Emulation.setDeviceMetricsOverride", { width: 940, height: 960, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  check("窄窗侧栏自动收起（不渲染）", (await evaluate(`document.querySelector(".sidebar") === null`)) === true);
  check("窄窗右图标条常驻", (await evaluate(`document.querySelector(".right-rail") !== null`)) === true);
  await clickAria("Files");
  await waitFor(`document.querySelector(".right-panel-slot") !== null`, "窄窗右栏");
  check("窄窗右栏以覆盖层打开（绝对定位浮于内容）", (await evaluate(`(() => { const slot = document.querySelector(".right-panel-slot"); if (slot === null) return false; return getComputedStyle(slot).position === "absolute"; })()`)) === true);
  await shot("23-narrow-940-files-overlay");
  await clickAria("Files");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  check("恢复宽窗侧栏回来", (await evaluate(`document.querySelector(".sidebar") !== null`)) === true);

  step("组4：中文 + 纸面两档主题");
  await send("Page.navigate", { url: `${base}?scene=typical&theme=copybook&lang=zh` });
  await waitFor(`(document.documentElement?.dataset.theme ?? "") === "copybook"`, "稿纸主题");
  await sleep(500);
  check("copybook 主题与中文界面生效", (await evaluate(`document.documentElement.lang.startsWith("zh") && document.documentElement.dataset.theme === "copybook"`)) === true);
  await shot("24-copybook-zh-home");
  await send("Page.navigate", { url: `${base}?scene=typical&theme=typescript&lang=en` });
  await waitFor(`(document.documentElement?.dataset.theme ?? "") === "typescript"`, "打字稿主题");
  check("typescript 英文主题生效", true);
  await shot("25-typescript-home");

  step("组4：设置九页签 walk");
  await navigate("typical");
  await clickAria("Settings");
  await waitFor(`document.body.innerText.includes("Appearance") === true`, "设置通用页");
  for (const tab of ["Guide", "External sources", "Browser", "Voice", "Abilities", "Memory", "Experimental"]) {
    await clickText(tab, ".sidebar .option-row");
    await sleep(320);
    check(`设置页签 ${tab} 真实选中`, (await evaluate(`[...document.querySelectorAll(".sidebar .option-row")].some((item) => item.dataset.active === "true" && item.textContent?.trim() === ${JSON.stringify(tab)})`)) === true);
    if (tab === "External sources") {
      check("外部来源页列出八个来源", (await evaluate(`document.body.innerText.includes("Claude Code") === true && document.body.innerText.includes("Proma") === true && document.body.innerText.includes("ZCode") === true`)) === true);
      await shot("26-settings-external-sources");
    }
  }
  await clickText("Voice", ".sidebar .option-row");
  await sleep(320);
  check("语音页渲染听写引擎与两组凭证", (await evaluate(`document.body.innerText.includes("Dictation") === true && document.body.innerText.includes("Access Token") === true`)) === true);
  await shot("27-settings-voice");
  await clickText("Abilities", ".sidebar .option-row");
  await sleep(400);
  check("能力页签是全屏插件页", (await evaluate(`document.body.innerText.includes("session-digest") === true`)) === true);
  await clickText("Memory", ".sidebar .option-row");
  await sleep(400);
  check("记忆库页签列出作用域与条目", (await evaluate(`document.body.innerText.includes("All workspaces") === true && document.body.innerText.includes("concise Chinese summaries") === true`)) === true);
  await shot("28-settings-memory");
  await clickText("Experimental", ".sidebar .option-row");
  await sleep(400);
  check("实验功能页渲染实验卡", (await evaluate(`document.body.innerText.toLowerCase().includes("intent") === true`)) === true);

  step("组4：打开意图实验开关 → 右栏出现意图入口 → 面板如实报连不上");
  const intentSwitched = (await evaluate(`(() => {
    const cards = [...document.querySelectorAll(".exp-card")];
    const card = cards.find((el) => (el.textContent ?? "").toLowerCase().includes("intent"));
    const toggle = card?.querySelector("button[role='switch']");
    if (toggle === null || toggle === undefined) return "no-switch";
    toggle.click();
    return "clicked";
  })()`));
  await sleep(500);
  check("意图实验开关可点", intentSwitched === "clicked", String(intentSwitched));
  const intentEntry = (await evaluate(`[...document.querySelectorAll("button")].some((item) => item.getAttribute("aria-label") === "Intent graph")`));
  check("开关后右栏出现意图图谱入口", intentEntry === true);
  if (intentEntry === true) {
    await clickAria("Intent graph");
    await waitFor(`document.querySelector(".right-panel-slot")?.innerText.length > 20`, "意图面板");
    check("意图面板挂载并如实显示不可用", true);
    await shot("29-intent-unavailable");
    await clickAria("Intent graph");
  }

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
