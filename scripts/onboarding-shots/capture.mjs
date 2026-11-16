#!/usr/bin/env node
/**
 * 新手引导截图：一条命令重拍全部，或只拍某几章 / 某几张。
 *
 *   node scripts/onboarding-shots/capture.mjs --cdp 39350 --dev 5350                 # 全部
 *   node scripts/onboarding-shots/capture.mjs --cdp 39350 --dev 5350 --chapter automation,board
 *   node scripts/onboarding-shots/capture.mjs --cdp 39350 --dev 5350 --shot plan,context
 *   node scripts/onboarding-shots/capture.mjs --cdp 39350 --dev 5350 --shot bg-status --no-reload   # both 场景：不重载（要留着在跑的子会话）
 *
 * 前提：一个灌好演示课题的隔离实例在跑（seed.mjs 的三步，见它的文件头），带 --remoteDebuggingPort。
 * 每个场景（scenes.mjs）：摆好 → 浅色拍一张、量框 → 切玄再拍一张 → 切回浅色 → 收尾动作。
 * 1440×900 视口、1 倍像素、webp 质量 75（两套共约 5 MB），直接让 Chromium 出 webp（不经第三方图像库），写进
 * src/renderer/src/features/onboarding/shots/{light,dark}/<id>.webp；量出的框（截图上的比例）写进同目录的
 * shot-boxes.ts——数据表 onboarding-pages.ts 按框名取坐标，界面挪了位置重拍即跟上，不手改坐标。
 * 每一步限时（scripts/cdp.mjs 的看门狗），卡住会报停在哪一步。拍完自己逐张看（AGENTS.md：截图必须自己看过）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectCdp, step } from "../cdp.mjs";
import { SCENES } from "./scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "src", "renderer", "src", "features", "onboarding");
/**
 * 先拍进临时目录、全部拍完再拷进 src：截图目录被渲染层 import.meta.glob 引用，dev server 盯着它——
 * 拍一张写一张会让正在被拍的实例整页重载（实测：场景拍到一半「target navigated」、面板全收）。
 */
const STAGE = mkdtempSync(join(tmpdir(), "orbita-onboarding-shots-"));
const { values: opt } = parseArgs({
  options: {
    cdp: { type: "string", default: "39350" },
    dev: { type: "string", default: "5350" },
    chapter: { type: "string" },
    shot: { type: "string" },
    quality: { type: "string", default: "75" },
    // 不重载页面换主题：只拍 both 场景（同一帧切 data-theme 拍玄）时用。重载会丢掉渲染层对「还在跑的子会话」的认识
    // （后台状态位那一页要拍着一个还在跑的子会话，重载后它在渲染层里就成了空闲）
    "no-reload": { type: "boolean", default: false },
    // 调选择器用：摆好这个场景（浅色），在页面里求值 --eval 并打印，不拍图
    probe: { type: "string" },
    eval: { type: "string" },
  },
});

/** 要拍哪些：--shot 直接给；--chapter 从数据表里取那几章用到的截图（GUIDE 是 .ts，Node 原生剥类型加载） */
async function wanted() {
  if (opt.shot) return new Set(opt.shot.split(","));
  if (opt.chapter) {
    const { GUIDE } = await import("../../src/renderer/src/features/onboarding/onboarding-pages.ts");
    const chapters = new Set(opt.chapter.split(","));
    const shots = GUIDE.filter((c) => chapters.has(c.id)).flatMap((c) => c.pages.flatMap((p) => (p.kind === "faq" ? [] : [p.shot])));
    // 拼图要用到底图：拍 browser 时 browser-chat 也得在
    if (shots.includes("browser")) shots.push("browser-chat");
    return new Set(shots);
  }
  return null;
}

const W = 1440;
const H = 900;
const DPR = 1;
const started = Date.now();
const only = await wanted();
const cdp = await connectCdp({ cdpPort: Number(opt.cdp), devPort: Number(opt.dev), commandTimeoutMs: 60_000, watchdogMs: 90 * 60_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewport = () => cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await viewport();

const finder = (css) =>
  typeof css === "string"
    ? css.startsWith("last:")
      ? `[...document.querySelectorAll(${JSON.stringify(css.slice(5))})].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight; }).at(-1)`
      : `document.querySelector(${JSON.stringify(css)})`
    : Array.isArray(css)
      ? `[...document.querySelectorAll(${JSON.stringify(css[0])})].find((e) => e.textContent.includes(${JSON.stringify(css[1])}) && e.getBoundingClientRect().width > 0)`
      : css.js;

async function centerOf(expr) {
  const p = await cdp.evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  if (!p) throw new Error(`找不到元素：${expr.slice(0, 120)}`);
  return p;
}
/** 鼠标事件。移动默认不按键（button: none）——带着 left 移动等于拖拽，后面的点击全会被吞 */
async function mouse(type, x, y, extra = {}) {
  const pressed = type === "mouseMoved" ? { button: "none" } : { button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, ...pressed, ...extra });
}
async function key(name) {
  const vk = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[name] ?? 0;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: vk });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name });
}

async function run(steps) {
  for (const s of steps ?? []) {
    // 条件步骤：if 为假就跳过这一步（例如任务已经在跑，就别再发一遍）
    if (s.if && !(await cdp.evaluate(s.if))) continue;
    if (s.eval) await cdp.evaluate(s.eval);
    if (s.click) {
      const [x, y] = await centerOf(finder(s.click));
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    }
    // 条件点击：condition 为真才真点（开关类入口：设置页、子视图，已经开着就别再点）
    if (s.clickIf && (await cdp.evaluate(s.clickIf[0]))) {
      const [x, y] = await centerOf(finder(s.clickIf[1]));
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    }
    if (s.clickText) {
      const [x, y] = await centerOf(finder(s.clickText));
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    }
    // type 可以是函数：每次执行时现算（例如带时间戳的文件名）
    if (s.type) await cdp.send("Input.insertText", { text: typeof s.type === "function" ? s.type() : s.type });
    if (s.key) await key(s.key);
    if (s.drag) {
      const [css, phrase] = s.drag;
      const pts = await cdp.evaluate(`(() => { const root = [...document.querySelectorAll(${JSON.stringify(css)})].reverse().find((e) => e.textContent.includes(${JSON.stringify(phrase)}));
        if (!root) return null; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(${JSON.stringify(phrase)}); if (i >= 0) {
          n.parentElement.scrollIntoView({ block: "center" }); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${phrase.length}); const rs = r.getClientRects(); const a = rs[0], b = rs[rs.length - 1];
          return [a.left + 1, a.top + a.height / 2, b.right - 1, b.top + b.height / 2]; } } return null; })()`);
      if (!pts) throw new Error(`找不到要划选的字：${phrase}`);
      await mouse("mousePressed", pts[0], pts[1]);
      await mouse("mouseMoved", pts[2], pts[3], { button: "left", buttons: 1 });
      await mouse("mouseReleased", pts[2], pts[3]);
    }
    if (s.wait) await sleep(s.wait);
    if (s.until) {
      const end = Date.now() + (s.timeout ?? 120_000);
      while (!(await cdp.evaluate(s.until))) {
        if (Date.now() > end) {
          // soft：到点不算失败，往下拍（agent 改完后可能还在自己检查，不影响取景）
          if (s.soft) break;
          throw new Error(`等不到：${s.until.slice(0, 80)}`);
        }
        await sleep(2000);
      }
    }
  }
}

async function measure(spec) {
  const body = Object.entries(spec ?? {})
    // 一个元素量它的外框；给出一组元素（js 返回数组）量它们合起来的外框
    .map(([name, css]) => `try { const found = ${finder(css)}; const els = Array.isArray(found) ? found : found ? [found] : [];
      const rs = els.map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      if (rs.length) { const x = Math.min(...rs.map((b) => b.left)), y = Math.min(...rs.map((b) => b.top)), x2 = Math.max(...rs.map((b) => b.right)), y2 = Math.max(...rs.map((b) => b.bottom));
        r[${JSON.stringify(name)}] = { x: +(x / innerWidth).toFixed(4), y: +(y / innerHeight).toFixed(4), w: +((x2 - x) / innerWidth).toFixed(4), h: +((y2 - y) / innerHeight).toFixed(4) }; } } catch {}`)
    .join("\n");
  return cdp.evaluate(`(() => { const r = {}; ${body} return r; })()`);
}

/**
 * 换主题：写设置再重载页面（一次干净的起点）。不走设置页点卡片——那要进出整页盖层，
 * 和场景自己开着的面板、子视图互相打架（实测会把右栏收掉、把「以后再做」关掉）。
 */
async function theme(id) {
  const before = await cdp.evaluate("performance.timeOrigin");
  await cdp.evaluate(`window.orbita.settings.set({ theme: ${JSON.stringify(id)} }).then(() => (setTimeout(() => location.reload(), 50), 1))`);
  // 等新页面真的起来（dev 模式下整包重载要好几秒）：新的 timeOrigin + 右栏与侧栏都渲染出来，再多等一拍
  const end = Date.now() + 60_000;
  for (;;) {
    await sleep(1000);
    const ready = await cdp
      .evaluate(`performance.timeOrigin !== ${before} && document.readyState === "complete" && !!document.querySelector(".right-rail button[aria-label='设置']") && !!document.querySelector("aside .workspace-group")`)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > end) throw new Error("重载后 60 秒没起来");
  }
  await sleep(1500);
  await viewport();
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // 重载后的第一下点击会被吞掉（窗口重新拿焦点）：先在首页空白处点一下
  await mouse("mousePressed", W / 2, 150);
  await mouse("mouseReleased", W / 2, 150);
  await sleep(300);
}

async function shoot(path) {
  await viewport();
  await cdp.send("Page.bringToFront");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // 鼠标挪到右缘空白处：别让悬停态（行尾动作键、提示）混进截图
  await mouse("mouseMoved", W - 3, H * 0.7);
  await sleep(500);
  const res = await cdp.send("Page.captureScreenshot", { format: "webp", quality: Number(opt.quality) }, 20_000);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(res.result.data, "base64"));
}

/** 内置浏览器是另一个窗口：拍它的工具条与页面两个 target，在页面里用 canvas 拼成一扇窗，压在底图右侧 */
async function browserComposite(scene, set) {
  const list = await (await fetch(`http://127.0.0.1:${opt.cdp}/json/list`)).json();
  const capture = async (target, method, params) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    if (method) await send(method, params);
    if (method === "Page.navigate") await sleep(6000);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    ws.close();
    return `data:image/png;base64,${shot.result.data}`;
  };
  const toolbar = list.find((t) => t.type === "page" && t.url.includes("browser-toolbar.html"));
  const page = list.find((t) => t.type === "page" && !t.url.includes("127.0.0.1"));
  if (!toolbar || !page) throw new Error("内置浏览器窗口没开：先点右栏的地球图标");
  const pageUrl = await capture(page, "Page.navigate", { url: scene.composite.url });
  const barUrl = await capture(toolbar);
  const base = readFileSync(join(STAGE, set, `${scene.composite.base}.webp`)).toString("base64");
  const data = await cdp.evaluate(`(async () => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [base, bar, page] = await Promise.all([load("data:image/webp;base64,${base}"), load(${JSON.stringify(barUrl)}), load(${JSON.stringify(pageUrl)})]);
    const c = document.createElement("canvas"); c.width = base.width; c.height = base.height; const g = c.getContext("2d");
    g.drawImage(base, 0, 0);
    g.fillStyle = "rgba(0,0,0,0.18)"; g.fillRect(0, 0, c.width, c.height);
    // 工具条 target 的视口是整扇窗，网页 webview 盖在它下半截：上面那条（总高 − 网页高）才是工具条
    const s = c.width / 1440, ww = 860 * s;
    const ph = page.height * (ww / page.width), bh = (bar.height - page.height) * (ww / bar.width);
    const x = c.width - ww - 70 * s, y = 120 * s;
    g.save(); g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = 60 * s; g.shadowOffsetY = 20 * s; g.fillStyle = "#fff"; g.fillRect(x, y, ww, bh + ph); g.restore();
    g.drawImage(bar, 0, 0, bar.width, bar.height - page.height, x, y, ww, bh);
    g.drawImage(page, x, y + bh, ww, ph);
    return { url: c.toDataURL("image/webp", ${Number(opt.quality) / 100}), box: { x: +(x / c.width).toFixed(4), y: +(y / c.height).toFixed(4), w: +(ww / c.width).toFixed(4), h: +((bh + ph) / c.height).toFixed(4) } };
  })()`, 60_000);
  mkdirSync(join(STAGE, set), { recursive: true });
  writeFileSync(join(STAGE, set, `${scene.id}.webp`), Buffer.from(data.url.split(",")[1], "base64"));
  return { window: data.box };
}

if (opt.probe) {
  const scene = SCENES.find((each) => each.id === opt.probe);
  if (!scene) throw new Error(`没有场景 ${opt.probe}`);
  await run(scene.steps);
  console.log(await cdp.evaluate(opt.eval ?? "1"));
  cdp.close();
  process.exit(0);
}

const boxesPath = join(OUT, "shot-boxes.ts");
const boxes = existsSync(boxesPath) ? JSON.parse(/SHOT_BOXES[^=]*= ([\s\S]*);\s*$/.exec(readFileSync(boxesPath, "utf8"))?.[1] ?? "{}") : {};
// 两遍：先全部浅色（顺手量框），再换玄全部重摆一遍。每个场景的步骤都可重跑（收尾会先重新打开、补一轮对话）
for (const set of ["light", "dark"]) {
  if (!opt["no-reload"]) await theme(set === "light" ? "light" : "black");
  for (const scene of SCENES) {
    if (only && !only.has(scene.id)) continue;
    // both：现跑的场景（浅、玄各跑一遍，两次跑到的进度、行数都不同，浅色量的框对不上玄的图）——
    // 浅色这一遍里同一时刻直接切 data-theme 再拍玄，两张图是同一帧；玄那一遍跳过
    if (scene.both && set === "dark") continue;
    step(`${set === "light" ? "浅" : "玄"} · ${scene.id}`);
    try {
      if (scene.composite) {
        await run([{ eval: "[...document.querySelectorAll('.right-rail button[aria-pressed=true]')].filter((b) => b.getAttribute('aria-label') !== '更多').forEach((b) => b.click()), 1" }, { click: ".right-rail button[aria-label='内置浏览器']" }, { wait: 2500 }]);
        const measured = await browserComposite(scene, set);
        if (set === "light") boxes[scene.id] = measured;
        continue;
      }
      await run(scene.steps);
      if (set === "light") boxes[scene.id] = await measure(scene.measure);
      await shoot(join(STAGE, set, `${scene.id}.webp`));
      if (scene.both) {
        await cdp.evaluate("document.documentElement.dataset.theme = 'black', 1");
        await sleep(700);
        await shoot(join(STAGE, "dark", `${scene.id}.webp`));
        await cdp.evaluate("document.documentElement.dataset.theme = 'light', 1");
        await sleep(300);
      }
      await run(scene.after);
    } catch (error) {
      console.error(`✖ ${set} · ${scene.id} 没拍成：${error.message}`);
      // 现场留一张图，方便看卡在什么界面上
      await shoot(join(tmpdir(), `onboarding-fail-${set}-${scene.id}.webp`)).catch(() => undefined);
    }
  }
}
if (!opt["no-reload"]) await theme("light");
// 拍完才一次性拷进 src（只覆盖这次拍了的；没拍成的保留旧图）
cpSync(STAGE, join(OUT, "shots"), { recursive: true });
rmSync(STAGE, { recursive: true, force: true });
const sorted = Object.fromEntries(Object.keys(boxes).sort().map((k) => [k, boxes[k]]));
writeFileSync(
  boxesPath,
  `/**\n * 由 scripts/onboarding-shots/capture.mjs 生成，不要手改：每张截图上量出的元素外框（截图上的比例，0–1）。\n * onboarding-pages.ts 按「截图 id → 框名」取用；重拍时随截图一起更新。\n */\nimport type { Box } from "./onboarding-pages.ts";\n\nexport const SHOT_BOXES: Readonly<Record<string, Readonly<Record<string, Box>>>> = ${JSON.stringify(sorted, null, 2)};\n`,
);
cdp.close();
console.log(`✔ 拍完，用时 ${Math.round((Date.now() - started) / 1000)} 秒。截图在 ${join(OUT, "shots")}，框在 shot-boxes.ts。`);
process.exit(0);
