#!/usr/bin/env node
/**
 * 新手引导截图的演示数据：把「城市感知课题」灌进一个**隔离实例**（不碰正式版数据）。
 * 引导截图都出自这个课题，前后接得上；界面改了要重拍时，先用它重灌一份数据，再跑 capture.mjs。
 *
 * 三步（每步都可单独重跑）：
 *
 *   1. 文件（实例**没在跑**时）：建工作区文件夹与课题文件（论文 PDF 从 arXiv 下载、笔记、复现脚本、数据切片、
 *      git 首提交），写实例的 settings.json（浅色、中文、看过引导、家务活模型、右栏 560、开 PDF 引用），
 *      从 --providers-from 实例复制服务商（**丢掉 scheme 为 oauth 的条目与它的密钥**），
 *      放一个「正在做」的插件草稿（组会纪要）。
 *        node scripts/onboarding-shots/seed.mjs files --instance onboarding-shots [--providers-from orbita-dev]
 *
 *   2. 剧本（实例**在跑**，带 CDP）：按 SCREENPLAY 逐条开任务、发话、等它跑完——真模型真跑，
 *      所以每次的回答文字会不一样，截图的取景靠 capture.mjs 按 DOM 量，不靠写死坐标。约 25–40 分钟。
 *        ORBITA_DEV_INSTANCE=onboarding-shots ORBITA_DEV_PORT=5350 ./node_modules/.bin/electron-vite dev --remoteDebuggingPort 39350
 *        node scripts/onboarding-shots/seed.mjs drive --cdp 39350 --dev 5350
 *
 *   3. 补历史（实例**没在跑**时；自动化面板与 store 全量常驻内存，跑着改文件会被覆盖）：
 *      自动化的近 7 天柱子与全局周看板要有一周的运行记录，真等一周不现实——拿剧本里那次真跑
 *      （同一条会话、同一张看板快照）往前铺 6 天，另加两条演示自动化（每周组会纪要、失败中的日志巡检）。
 *        node scripts/onboarding-shots/seed.mjs fixup --instance onboarding-shots
 *
 * 收尾：node scripts/.../instance-data.py clean <实例名> --yes（或手动删 userData 与 ~/Orbita-dev-<实例名>）。
 * 截图里不能出现真实数据：终端提示符在 capture 里改成「目录名 %」，插件作者写成「城市感知课题组」。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { connectCdp, step } from "../cdp.mjs";
import { PROJECT_FILES, SCREENPLAY, WORKSPACE_NAME, GROUP_MEETING_DRAFT } from "./demo.mjs";

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    instance: { type: "string", default: "onboarding-shots" },
    "providers-from": { type: "string", default: "orbita-dev" },
    cdp: { type: "string", default: "39350" },
    dev: { type: "string", default: "5350" },
    from: { type: "string" },
  },
});
const mode = positionals[0];
const APP = join(homedir(), "Library", "Application Support");
const userData = join(APP, `orbita-dev-${opt.instance}`);
const root = join(homedir(), `Orbita-dev-${opt.instance}`);
const workspaceDir = join(root, WORKSPACE_NAME);

/** 原子写（临时文件 + rename），同仓库对配置文件的纪律 */
function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  execFileSync("mv", [tmp, path]);
}

function seedFiles() {
  if (["", "orbita", "orbita-dev"].includes(opt.instance)) throw new Error("实例名不能是正式版 / 默认开发版的目录");
  mkdirSync(userData, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  for (const [rel, content] of Object.entries(PROJECT_FILES)) {
    const path = join(workspaceDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const pdf = join(workspaceDir, "papers", "UrbanGPT-2403.00813.pdf");
  if (!existsSync(pdf)) execFileSync("curl", ["-sL", "-m", "120", "-o", pdf, "https://arxiv.org/pdf/2403.00813"]);
  if (!existsSync(join(workspaceDir, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: workspaceDir });
    execFileSync("git", ["add", "."], { cwd: workspaceDir });
    execFileSync("git", ["-c", "user.name=研究生", "-c", "user.email=student@example.com", "commit", "-qm", "课题起步：论文、笔记、复现脚本"], { cwd: workspaceDir });
  }
  for (const [rel, content] of Object.entries(GROUP_MEETING_DRAFT)) {
    const path = join(workspaceDir, "plugins", "group-meeting", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const settingsPath = join(userData, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  writeJson(settingsPath, {
    ...settings,
    theme: "light",
    language: "zh",
    onboardingSeen: true,
    rightPanelWidth: 560,
    choreModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
    lastUsed: { providerId: "zhipu-coding", modelId: "glm-5.3", mode: "auto" },
    experimentalFeatures: { "pdf-citations": true },
  });
  // 服务商：只要 api_key 的；oauth（例如 Claude 订阅登录）连条目带密钥一起丢，绝不带进演示实例
  const source = join(APP, opt["providers-from"]);
  const providers = JSON.parse(readFileSync(join(source, "providers.json"), "utf8"));
  const secrets = existsSync(join(source, "secrets.json")) ? JSON.parse(readFileSync(join(source, "secrets.json"), "utf8")) : {};
  const kept = providers.providers.filter((p) => p.auth?.scheme !== "oauth");
  const keptAccounts = new Set(kept.map((p) => p.auth?.secretRef?.account).filter(Boolean));
  writeJson(join(userData, "providers.json"), { ...providers, providers: kept });
  writeJson(join(userData, "secrets.json"), Object.fromEntries(Object.entries(secrets).filter(([k]) => keptAccounts.has(k))));
  console.log(`✔ 文件就绪：${workspaceDir}\n  服务商 ${kept.length} 个（丢掉 oauth ${providers.providers.length - kept.length} 个）`);
}

/** 剧本：每一幕在指定任务里发一句话，等它跑完（停止键消失）再下一幕 */
async function drive() {
  const cdp = await connectCdp({ cdpPort: Number(opt.cdp), devPort: Number(opt.dev), commandTimeoutMs: 60_000, watchdogMs: 3 * 3600_000 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = async (expr) => {
    const p = await cdp.evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    if (!p) throw new Error(`找不到：${expr}`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: p[0], y: p[1], button: "left", clickCount: 1 });
  };
  const idle = async (limitMs) => {
    const end = Date.now() + limitMs;
    await sleep(5000);
    while (Date.now() < end) {
      const busy = await cdp.evaluate(`!!document.querySelector(".btn-accent[data-tone=danger]")`);
      if (!busy) return;
      await sleep(4000);
    }
    console.log("  （超时，继续下一幕）");
  };
  // 工作区：已有同名的就用它
  await cdp.evaluate(`window.orbita.workspace.create(${JSON.stringify(WORKSPACE_NAME)}).then(() => 1)`);
  await cdp.evaluate("location.reload(), 1");
  await sleep(4000);
  const start = SCREENPLAY.findIndex((scene) => scene.id === (opt.from ?? SCREENPLAY[0].id));
  for (const scene of SCREENPLAY.slice(Math.max(0, start))) {
    step(`第 ${scene.id} 幕：${scene.prompt.slice(0, 30)}…`);
    await cdp.evaluate(`[...document.querySelectorAll(".right-rail button[aria-pressed=true]")].forEach((b) => b.click()), 1`);
    if (scene.task === "new") {
      await cdp.evaluate(`document.querySelectorAll(".workspace-group button[aria-expanded=false]").forEach((b) => b.click()), 1`);
      await click(`document.querySelector('aside button[aria-label="在此工作区新建任务"]')`);
    } else if (scene.task === "plugin-maker") {
      await click(`document.querySelector('button[aria-label="能力"]')`);
      await sleep(1200);
      await click(`[...document.querySelectorAll(".right-panel-slot button")].find((b) => b.textContent.includes("和智能体一起做一个"))`);
    } else {
      await cdp.evaluate(`(() => { document.querySelectorAll(".workspace-group button[aria-expanded=false]").forEach((b) => b.click());
        const more = [...document.querySelectorAll("aside *")].find((e) => e.children.length <= 2 && /^再显示/.test(e.textContent.trim())); more?.click(); return 1; })()`);
      await sleep(500);
      await click(`[...document.querySelectorAll("aside .task-row")].find((r) => r.textContent.includes(${JSON.stringify(scene.task)}))`);
    }
    await sleep(1200);
    await click(`document.querySelector("textarea.composer-input")`);
    if (scene.task === "plugin-maker") {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 4 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", modifiers: 4 });
    }
    await cdp.send("Input.insertText", { text: scene.prompt });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    if (scene.wait !== false) await idle((scene.minutes ?? 12) * 60_000);
  }
  // 插件作者别带出机器用户名
  const manifest = join(workspaceDir, "plugins", "arxiv-daily", ".claude-plugin", "plugin.json");
  if (existsSync(manifest)) {
    const raw = JSON.parse(readFileSync(manifest, "utf8"));
    raw.author = { name: "城市感知课题组" };
    writeFileSync(manifest, `${JSON.stringify(raw, null, 2)}\n`);
  }
  // 自动化的第一次真跑（插件看板快照的来源）
  await cdp.evaluate(`window.orbita.automation.list().then((list) => { const a = list.find((x) => x.status === "active" && x.target.kind === "new_session"); return a ? window.orbita.automation.act(a.id, { type: "runNow" }).then(() => a.id) : null; })`);
  await idle(10 * 60_000);
  cdp.close();
  console.log("✔ 剧本跑完。停掉实例后跑 fixup。");
}

/** 补一周的运行历史与两条演示自动化 */
function fixup() {
  const path = join(userData, "automations.json");
  const store = JSON.parse(readFileSync(path, "utf8"));
  const DAY = 86_400_000;
  const today9 = new Date();
  today9.setHours(9, 0, 0, 0);
  const daily = store.automations.find((a) => a.status === "active" && a.runs.some((r) => r.boardSnapshotIds?.length));
  if (daily === undefined) throw new Error("没找到跑过一次、带看板快照的自动化——先跑完 drive");
  const real = daily.runs.find((r) => r.boardSnapshotIds?.length);
  const history = [];
  // 近 7 天：今天这次真跑 + 往前 6 天里跑了 5 天（其中 3 天前那次失败 = 红柱），每天 1–3 次，柱子高低才看得出
  const perDay = [1, 2, 1, 0, 3, 1];
  perDay.forEach((count, i) => {
    for (let k = 0; k < count; k += 1) {
      const run = { ...real, id: `${real.id}-d${i + 1}-${k}`, runAt: today9.getTime() - (i + 1) * DAY + k * 3_600_000, trigger: k === 0 ? "schedule" : "manual", durationMs: 180_000 + k * 20_000 };
      // 3 天前那次抓取失败：柱状图里要有一根红柱（引导第 11 章配文讲「失败的那天是红柱」）
      if (i === 2) {
        run.status = "error";
        run.error = "arXiv 抓取超时，没能挑出今天这一篇";
        delete run.boardSnapshotIds;
        delete run.resultExcerpt;
      }
      history.push(run);
    }
  });
  daily.runs = [real, ...history].sort((a, b) => b.runAt - a.runAt);
  daily.runCount = 28;
  const ws = daily.target.workspaceId;
  const base = { mode: "plan", createdBy: { kind: "user" }, consecutiveFailures: 0, createdAt: Date.now() - 20 * DAY, updatedAt: Date.now() };
  const mk = (id, runs) => runs.map(([dayAgo, status, extra], i) => ({ id: `${id}-r${i}`, runAt: today9.getTime() - dayAgo * DAY + 8 * 3_600_000, trigger: "schedule", status, sessionId: null, durationMs: status === "success" ? 95_000 : 12_000, tokens: null, ...(extra ?? {}) }));
  const extra = [
    {
      ...base,
      id: "demo-weekly-meeting",
      title: "每周五整理本周组会纪要与待办",
      prompt: "整理本周各会话里的组会纪要和待办，写进 notes/。",
      schedule: { kind: "daily", time: "17:00", weekdays: [5] },
      target: { kind: "new_session", workspaceId: ws },
      status: "active",
      nextRunAt: today9.getTime() + 7 * DAY,
      runs: mk("demo-weekly-meeting", [[0, "success"]]),
      runCount: 12,
    },
    {
      ...base,
      id: "demo-log-watch",
      title: "训练日志巡检",
      prompt: "看 logs/train.log 最后 50 行，loss 不降或报错就告诉我。",
      schedule: { kind: "interval", unit: "hour", every: 6 },
      target: { kind: "new_session", workspaceId: ws },
      status: "failed",
      nextRunAt: null,
      consecutiveFailures: 3,
      failureReason: "连续失败后已停下：日志文件不在了",
      runs: mk("demo-log-watch", [[0, "error", { error: "logs/train.log 不存在" }], [1, "error", { error: "logs/train.log 不存在" }], [2, "success"], [3, "success"], [3, "success"]]),
      runCount: 5,
    },
  ];
  store.automations = [daily, ...extra, ...store.automations.filter((a) => a !== daily && !a.id.startsWith("demo-"))];
  writeJson(path, store);
  console.log(`✔ 自动化：${daily.title} 铺了 ${history.length} 次历史，另加 ${extra.length} 条演示自动化`);
}

if (mode === "files") seedFiles();
else if (mode === "drive") await drive();
else if (mode === "fixup") fixup();
else {
  console.error("用法见文件头：files | drive | fixup");
  process.exit(1);
}
