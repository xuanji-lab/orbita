/**
 * 新手引导的截图场景：每张图怎么摆（点哪、开哪个面板、划哪段字）、量哪些元素的外框。
 * capture.mjs 逐个执行；id 就是 onboarding-pages.ts 里的 ShotId（截图文件名），measure 的名字就是
 * shot-boxes.ts 里的框名（数据表用它们定框选、编号点、放大镜）。
 *
 * 步骤：{ eval } 页面里执行一段表达式 · { click: css } · { clickText: [css, 含这段字] } · { key } · { type } 往焦点里打字
 * · { drag: [css, 一段原文] } 用鼠标划选 · { wait: 毫秒 } · { until: 表达式, timeout }。
 * 量框：css（第一个）· "last:css"（最后一个可见的）· [css, 含这段字] · { js: 返回元素的表达式 }。
 * 场景依赖 seed.mjs 的剧本产出的任务（按标题关键词找）；界面改了，改这里的选择器即可，坐标不手写。
 */

/** 收起右栏面板与整页盖层（设置、看板）；「更多」亮着是子视图开着，点它只会弹菜单，跳过 */
const RESET = { eval: "[...document.querySelectorAll('.right-rail button[aria-pressed=true]')].filter((b) => b.getAttribute('aria-label') !== '更多').forEach((b) => b.click()), 1" };
const BOTTOM = { eval: "document.querySelector('.chat-transcript').scrollTop = 1e7, 1" };
const TOP = { eval: "document.querySelector('.chat-transcript').scrollTop = 0, 1" };

const CARRYOVERS_OPEN = "!!document.querySelector(\"aside button[aria-label='返回任务']\")";
const TOGGLE_CARRYOVERS = "(async () => { document.querySelector(\"button[aria-label='更多']\").click(); await new Promise((r) => setTimeout(r, 400)); [...document.querySelectorAll('.menu-panel [role=menuitem], .menu-panel button')].find((b) => b.textContent.includes('以后再做'))?.click(); return 1; })()";
const OPEN_CARRYOVERS = `(${CARRYOVERS_OPEN}) ? 1 : ${TOGGLE_CARRYOVERS}`;
const CLOSE_CARRYOVERS = `(${CARRYOVERS_OPEN}) ? ${TOGGLE_CARRYOVERS} : 1`;

/** 侧栏里打开标题含 keyword 的任务（工作区折着先展开、藏在「再显示」里先放出来） */
function openTask(keyword) {
  return [
    RESET,
    { eval: CLOSE_CARRYOVERS },
    { wait: 500 },
    { eval: "document.querySelectorAll('.workspace-group button[aria-expanded=false]').forEach((b) => b.click()), 1" },
    { wait: 500 },
    { eval: `[...document.querySelectorAll('aside .task-row')].some((r) => r.textContent.includes(${JSON.stringify(keyword)})) ? 1 : ([...document.querySelectorAll('aside *')].find((e) => e.children.length <= 2 && /^再显示/.test(e.textContent.trim()))?.click(), 1)` },
    { until: `[...document.querySelectorAll('aside .task-row')].some((r) => r.textContent.includes(${JSON.stringify(keyword)}) && r.getBoundingClientRect().width > 0)`, timeout: 8000 },
    { clickText: ["aside .task-row", keyword] },
    { wait: 1500 },
  ];
}

const SETTINGS_OPEN = "document.querySelector(\"button[aria-label='设置'][aria-pressed=true]\")";
/** 设置页是开关：已经开着就不再点 */
function settingsTab(name) {
  // 先收右栏面板：上一个场景留下的面板会把设置页挤窄（记忆库页一窄就变成两列）
  return [RESET, { wait: 300 }, { eval: CLOSE_CARRYOVERS }, { clickIf: [`!(${SETTINGS_OPEN})`, "button[aria-label='设置']"] }, { until: "[...document.querySelectorAll('aside .option-row')].some((b) => b.getBoundingClientRect().width > 0)", timeout: 8000 }, { clickText: ["aside .option-row, aside button", name] }, { wait: 1200 }];
}
const CLOSE_SETTINGS = { clickIf: [`!!(${SETTINGS_OPEN})`, "button[aria-label='设置']"] };
/** 打开右栏某面板：每条任务会记住自己上次开着的面板，已经亮着就别再点（再点是收起） */
const rail = (label) => ({ clickIf: [`!document.querySelector(".right-rail button[aria-label^='${label}'][aria-pressed=true]")`, `.right-rail button[aria-label^='${label}']`] });
const PANEL = ".right-panel-slot";

/** 当前任务没在跑（停止键不在） */
const IDLE = "!document.querySelector('.btn-accent[data-tone=danger]')";

/** 每次（浅、玄各一遍）给「现跑的一轮」一个新文件名：同一件事做过就不会再动手（实测：重发同一句，它回「昨晚已经做过」） */
const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, "");

export const READ = "复现 UrbanGPT";
const SUBS = "UrbanGPT三篇";
const TERM = "跑基线";
const BROWSE = "arXiv检索";
const PLUGIN = "创建 arXiv";
const PDF = "UrbanGPT零样本";

export const SCENES = [
  { id: "home", steps: [RESET, { wait: 300 }, { click: "aside button[aria-label='在此工作区新建任务']" }, { wait: 1500 }],
    measure: { sidebar: ".workspace-group", composer: ".composer-stack .glass-card", rail: ".rail-stack", cards: ".home-stage .glass-card", newTask: "aside button[aria-label='在此工作区新建任务']" } },
  { id: "providers", steps: settingsTab("模型服务"), after: [CLOSE_SETTINGS],
    measure: { added: { js: "[...document.querySelectorAll('.pv-vcard')].find((c) => c.textContent.includes('GLM Coding Plan'))?.querySelector('.pv-card-switch')" }, plan: [".pv-vcard", "GLM Coding Plan"], deepseek: [".pv-vcard", "DeepSeek"], filter: ["button", "仅显示已添加"] } },
  { id: "general", steps: [...settingsTab("通用"), { until: "[...document.querySelectorAll('.set-row-name')].some((e) => e.textContent.trim() === '家务活模型')", timeout: 8000 }, { eval: "[...document.querySelectorAll('.set-row-name')].find((e) => e.textContent.trim() === '家务活模型').scrollIntoView({ block: 'center' }), 1" }, { wait: 400 }], after: [CLOSE_SETTINGS],
    measure: { chore: [".set-row", "给任务起名"], sub: [".set-row", "任务委派出去"] } },
  { id: "migration", steps: [...settingsTab("迁移"), { wait: 1000 }], after: [CLOSE_SETTINGS],
    measure: { scan: ["button", "扫描"], readonly: ["span", "只读"], importBtn: ["button", "导入"] } },
  { id: "composer", steps: [...openTask(READ), BOTTOM, { wait: 400 }],
    measure: { clip: "button[aria-label^='附加文件']", ws: [".composer-bottom-bar button", "城市感知课题"], perm: [".composer-bottom-bar button", "放行"], model: [".composer-bottom-bar button", "GLM"], think: [".composer-bottom-bar button", "最高"], card: ".composer-stack .glass-card", bar: ".composer-bottom-bar" } },
  { id: "permission", steps: [...openTask(READ), BOTTOM, { clickText: [".composer-bottom-bar button", "放行"] }, { wait: 600 }], after: [{ key: "Escape" }],
    measure: { menu: ".menu-panel", perm: [".composer-bottom-bar button", "放行"] } },
  { id: "rewind", steps: [...openTask(READ), { eval: "[...document.querySelectorAll('.bubble-md')].find((b) => b.textContent.includes('小标题'))?.scrollIntoView({ block: 'start' }), 1" }, { wait: 400 }],
    measure: { rewind: { js: "[...document.querySelectorAll('.bubble-md')].find((b) => b.textContent.includes('小标题'))?.parentElement?.parentElement?.parentElement?.querySelector(\"button[aria-label^='回到这里']\")" },
      undo: "last:button[aria-label^='撤销这一轮']", bubble: [".bubble-md", "小标题"] } },
  // 现跑的一轮：在工作区里新开一条任务交一件要好几步的活，开跑十来秒时拍（计划已列、工具在跑）。
  // 每次重拍都会多一条任务——不在老任务里重发：同一句话发到第 N 遍，它会开始讲「第 N 份副本」，露馅。
  // both：浅、玄两张取自同一帧（capture.mjs 里浅色这一遍直接切 data-theme 再拍玄），量的框才对得上两张图。
  { id: "working", both: true,
    steps: [RESET, { eval: CLOSE_CARRYOVERS }, { wait: 500 }, { eval: "document.querySelectorAll('.workspace-group button[aria-expanded=false]').forEach((b) => b.click()), 1" }, { wait: 500 },
      { click: "aside button[aria-label='在此工作区新建任务']" }, { wait: 1500 }, { click: "textarea.composer-input" },
      { type: () => `把论文 Table 1 里各模型在 NYC-taxi 上的 MAE 抄成一张 CSV 存到 data/mae_${stamp()}.csv，再用 matplotlib 画一张对比柱状图存到 figures/。先用 update_plan 列计划，用中文，命令里只写相对路径。` }, { key: "Enter" },
      { until: "document.querySelectorAll('.chat-transcript .bubble-md').length > 0 && !!document.querySelector('.btn-accent[data-tone=danger]')", timeout: 20000 }, { wait: 12000 }, BOTTOM, { wait: 300 }],
    after: [{ until: IDLE, timeout: 180000 }, { wait: 3000 }],
    measure: { block: { js: "(() => { const last = [...document.querySelectorAll('.bubble-md')].at(-1); const floor = last ? last.getBoundingClientRect().bottom + 30 : 0; return [...document.querySelectorAll('.chat-transcript *')].filter((e) => e.children.length === 0 && e.getBoundingClientRect().top > floor && e.getBoundingClientRect().bottom < innerHeight - 150); })()" }, stop: ".btn-accent[data-tone=danger]" } },
  { id: "plan", steps: [...openTask(READ), rail("这条任务"), { wait: 800 }, { clickText: ["[role=tab], .toolbar button", "进度"] }, { wait: 800 }],
    measure: { panel: PANEL, goal: ".right-panel-slot section.tp-goal",
      plan: { js: "document.querySelector('.right-panel-slot .tp-step')?.closest('section')" },
      done: [`${PANEL} button`, "做过的"], ctx: [`${PANEL} button`, "上下文"] } },
  { id: "context", steps: [...openTask(READ), rail("这条任务"), { wait: 800 }, { clickText: ["[role=tab], .toolbar button", "上下文"] }, { wait: 1000 }, { clickText: [`${PANEL} button, ${PANEL} [role=tab]`, "整个任务"] }, { wait: 1500 }],
    measure: { panel: PANEL, used: [`${PANEL} div`, "已用"], files: [`${PANEL} button`, "文件"] } },
  { id: "review", steps: [...openTask(READ), rail("审查改动"), { wait: 1500 }, { clickText: ["button.review-row", "可复现实验.md"] }, { wait: 1500 }],
    measure: { panel: PANEL, row: ["button.review-row", "可复现实验.md"], row2: ["button.review-row", "download_e1"] } },
  { id: "files", steps: [...openTask(READ), rail("文件"), { wait: 1200 }, { clickText: [`${PANEL} button, ${PANEL} span`, "papers"] }, { wait: 700 }, { clickText: [`${PANEL} button, ${PANEL} span`, "UrbanGPT-2403"] }, { wait: 3000 }],
    measure: { panel: PANEL, crumb: [".toolbar span, .toolbar button", "UrbanGPT-2403"] } },
  { id: "quote", keepMouse: true,
    steps: [...openTask(READ), { eval: "[...document.querySelectorAll('.assistant-prose')].find((p) => p.textContent.includes('千兆宽带'))?.scrollIntoView({ block: 'center' }), 1" }, { wait: 400 },
      { drag: [".assistant-prose", "按千兆宽带估 5-10 分钟"] }, { wait: 500 }, { clickText: ["button", "引用"] }, { wait: 600 },
      { drag: [".assistant-prose", "本机跑通 E1+E2 零样本实验，数值对上论文"] }, { wait: 600 }],
    after: [{ eval: "getSelection().removeAllRanges(), 1" }, { clickIf: ["!!document.querySelector(\"button[aria-label='移除引用']\")", "button[aria-label='移除引用']"] }],
    measure: { toolbar: { js: "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '摘抄')?.parentElement" }, quote: { js: "[...document.querySelectorAll('.composer-stack > *')].find((e) => e.textContent.includes('千兆'))" } } },
  { id: "excerpts", steps: [...openTask(READ), BOTTOM, { wait: 400 }, { drag: [".assistant-prose", "下一步就是真实下载"] }, { wait: 500 }, { clickText: ["button", "摘抄"] }, { wait: 800 }, { eval: "getSelection().removeAllRanges(), 1" }, rail("审查改动"), { wait: 800 }, { clickText: [".toolbar button, [role=tab]", "摘抄"] }, { wait: 1200 }],
    measure: { panel: PANEL, first: { js: "[...document.querySelectorAll('.right-panel-slot *')].find((e) => e.children.length === 0 && e.textContent.includes('下一步就是真实下载'))?.parentElement" } } },
  { id: "pdf-cite", steps: [...openTask(PDF), { eval: "[...document.querySelectorAll('sup.chat-cite a')][2]?.click(), 1" }, { wait: 3500 }],
    measure: { cite: { js: "[...document.querySelectorAll('sup.chat-cite')][2]" }, panel: PANEL, mark: ".pdf-cite-mark" } },
  { id: "task-ref", steps: [...openTask(READ), { eval: "[...document.querySelectorAll('.bubble-md')].find((b) => b.textContent.includes('小标题'))?.scrollIntoView({ block: 'start' }), 1" }, { wait: 400 }],
    measure: { bubble: [".bubble-md", "小标题"], turn: ["button.collapse-row-btn", "read_task"], answer: [".assistant-prose", "已补到"] } },
  { id: "delegate", steps: [...openTask(SUBS), TOP, { wait: 400 }],
    measure: { bubble: ".bubble-md", cards: { js: "[...document.querySelectorAll('.chat-transcript *')].filter((e) => e.children.length === 0 && e.textContent.trim() === '已委派').map((e) => e.closest('button')).slice(0, 3)" } } },
  { id: "subsessions", steps: [...openTask(SUBS), { click: ".right-rail button[aria-label*='子会话']" }, { wait: 1500 }],
    measure: { panel: PANEL, rail: ".right-rail button[aria-label*='子会话']", first: { js: "document.querySelector('.right-panel-slot .option-row, .right-panel-slot button')" }, capsule: { js: "[...document.querySelectorAll('.toolbar button, .toolbar span')].find((e) => /^\\d+$/.test(e.textContent.trim()))" } } },
  { id: "memory", steps: [...openTask(PDF), { click: "button.memrow-btn" }, { wait: 1200 }], after: [{ key: "Escape" }],
    measure: { row: "button.memrow-btn", list: { js: "[...document.querySelectorAll('.chat-transcript *')].find((e) => e.textContent.includes('在审查面板里看'))?.parentElement" } } },
  { id: "memory-library", steps: settingsTab("记忆库"), after: [CLOSE_SETTINGS],
    measure: { scopes: { js: "[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === '范围')?.parentElement" }, entries: { js: "[...document.querySelectorAll('.mem-entry')].slice(0, 2)" } } },
  { id: "terminal", steps: [...openTask(TERM), rail("终端"), { until: "!!document.querySelector('.xterm-screen')", timeout: 20000 }, { wait: 2000 }, { click: ".xterm-screen" }, { type: "PROMPT='%1~ %% '; clear" }, { key: "Enter" }, { wait: 400 }, { type: "python3 code/repro_zero_shot.py" }, { key: "Enter" }, { wait: 800 }, { type: "tail -3 logs/train.log" }, { key: "Enter" }, { wait: 800 }],
    measure: { term: ".xterm-screen", rail: ".right-rail button[aria-label='终端']" } },
  { id: "background", steps: [...openTask(TERM), { eval: "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('在右栏查看'))?.scrollIntoView({ block: 'center' }), 1" }, { wait: 400 }],
    measure: { card: { js: "[...document.querySelectorAll('button')].find((e) => e.textContent.includes('在右栏查看'))?.parentElement?.parentElement" } } },
  { id: "browser-chat", steps: [...openTask(BROWSE), TOP, { wait: 300 }],
    measure: { turn: "button.collapse-row-btn", answer: ".assistant-prose", rail: ".right-rail button[aria-label='内置浏览器']" } },
  { id: "browser", composite: { base: "browser-chat", url: "https://arxiv.org/search/?query=urban+spatio-temporal+LLM&searchtype=all" },
    measure: {} },
  { id: "plugins", steps: [...openTask(PLUGIN), rail("能力"), { wait: 1500 }],
    measure: { panel: PANEL, make: [`${PANEL} button`, "和智能体一起做一个"], local: [`${PANEL} button`, "接入本地插件"], drafting: ["button.pl-draft-main", "组会纪要"] } },
  { id: "plugin-make", steps: [...openTask(PLUGIN), rail("能力"), { wait: 1500 }, TOP, { wait: 300 }],
    measure: { bubble: ".bubble-md", make: [`${PANEL} button`, "和智能体一起做一个"] } },
  { id: "plugin-draft", steps: [...openTask(PLUGIN), rail("能力"), { wait: 1500 }, { eval: "document.querySelector('button.pl-draft-main') ? 1 : ([...document.querySelectorAll('.toolbar button')].find((b) => /返回|全部插件/.test(b.getAttribute('aria-label') ?? b.textContent))?.click(), 1)" }, { wait: 800 }, { clickText: ["button.pl-draft-main", "组会纪要"] }, { wait: 1500 }],
    measure: { panel: PANEL, workflow: [".right-panel-slot .pl-card", "工作流"],
      pending: { js: "[...document.querySelectorAll('.right-panel-slot *')].find((e) => e.children.length === 0 && e.textContent.trim() === '看板样式')?.parentElement?.parentElement" } } },
  { id: "plugin-board", steps: [...openTask(PLUGIN), BOTTOM, { wait: 1000 }],
    measure: { card: { js: "[...document.querySelectorAll('.chat-transcript iframe')].at(-1)?.parentElement" } } },
  { id: "automation", steps: [...openTask(TERM), rail("自动化"), { wait: 1500 }],
    measure: { panel: PANEL, daily: [`${PANEL} button, ${PANEL} [role=button], ${PANEL} li`, "每天 09:00 · 下次"], failing: [`${PANEL} button, ${PANEL} [role=button], ${PANEL} li`, "训练日志巡检"] } },
  { id: "automation-edit", steps: [...openTask(TERM), rail("自动化"), { wait: 1200 }, { clickText: [`${PANEL} button, ${PANEL} [role=button]`, "每天 09:00 · 下次"] }, { wait: 1500 }],
    measure: { panel: PANEL, when: [`${PANEL} div`, "什么时候"], edit: [`${PANEL} button`, "改设置"] } },
  { id: "board-week", steps: [RESET, { wait: 300 }, { click: "button[aria-label='看板']" }, { wait: 2500 }, { clickText: ["button", "7 天"] }, { wait: 1200 },
      { eval: "(() => { const s = [...document.querySelectorAll('.wk *')].find((e) => e.scrollWidth > e.clientWidth + 20 && getComputedStyle(e).overflowX !== 'visible'); if (s) s.scrollLeft = s.scrollWidth; return 1; })()" }, { wait: 800 }],
    after: [{ clickIf: ["!!document.querySelector(\"button[aria-label='看板'][aria-pressed=true]\")", "button[aria-label='看板']"] }],
    measure: { days: ["button", "7 天"], today: { js: "[...document.querySelectorAll('.wk *')].find((e) => e.children.length === 0 && e.textContent.trim() === '今天')" }, card: { js: "[...document.querySelectorAll('.wk iframe')].at(-1)?.parentElement" } } },
  { id: "focus", steps: [...openTask(READ), { click: "button[aria-label^='专注模式']" }, { wait: 1000 }], after: [{ key: "Escape" }],
    measure: { key: "button[aria-label^='专注模式']", picker: ".menu-panel, [role=dialog]" } },
  // 收尾：点勾 → 等扫描结果卡（家务活模型现扫，一次十几秒到一分钟）→ 浅 / 玄都拍完才点「确认」（确认后卡就收起了）
  // 可重跑：任务已收尾过就先重新打开，再补一轮对话（收尾只扫上次收尾之后的新对话，没新对话就不出卡）
  { id: "closing", steps: [...openTask(BROWSE), { clickIf: ["!!document.querySelector(\".toolbar button[aria-label='重新打开任务']\")", ".toolbar button[aria-label='重新打开任务']"] }, { wait: 800 },
      { click: "textarea.composer-input" }, { type: "在 notes/ 里给刚下载的这篇论文记一行：标题、会议、为什么和 UrbanGPT 最相关。" }, { key: "Enter" }, { wait: 5000 },
      { until: "!document.querySelector('.btn-accent[data-tone=danger]')", timeout: 300000 }, { wait: 1500 },
      { click: ".toolbar button[aria-label='标记任务完成']" }, { until: "!!document.querySelector('.glass-card button.btn-accent') && [...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('确认：'))", timeout: 180000 }, { wait: 800 }],
    after: [{ clickText: ["button", "确认："] }, { wait: 2500 }],
    measure: { card: { js: "[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === '收尾这个任务')?.closest('.glass-card')" }, tick: ".toolbar button[aria-label='标记任务完成'], .toolbar button[aria-label^='重新打开']", confirm: ["button", "确认："] } },
  // 「以后再做」子视图是开关：已经开着就别再点（再点会关掉）
  { id: "carryovers", steps: [RESET, { wait: 300 }, { eval: OPEN_CARRYOVERS }, { wait: 1200 }, { eval: "document.querySelectorAll(\"aside button[aria-label='展开分组']\").forEach((b) => b.click()), 1" }, { wait: 800 }],
    after: [{ eval: CLOSE_CARRYOVERS }],
    measure: { more: "button[aria-label='更多']", list: "aside" } },
];
