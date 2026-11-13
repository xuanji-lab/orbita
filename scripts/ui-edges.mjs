/**
 * 行尾血线几何守卫（2026-10 验收 M）——量「行尾元素是否钉在右血线上」。
 *
 * 规矩（设计系统 readme *Implementation rules* / styles.css 的 .row-trailing 注释）：
 * 行 / 卡 / 列表项的尾部元素（状态标记、注脚、计数）右缘，必须落在行的右内边距上，
 * 与左侧首个元素的左缘同一条基线；悬停才出现的动作键不得在平时占位。
 * 静态读不出几何（padding、flex、字体都会影响），所以这里用 CDP 驱动真应用量像素：
 * 对每个检查项，量「尾部元素右缘 → 行右缘」与「首元素左缘 → 行左缘」的差，
 * 与期望内边距比，超出 1px 即违规、exit 1。
 *
 * 用法：
 *   1. 带调试端口起隔离实例（见 scripts/cdp.mjs 头注释）：
 *        ORBITA_DEV_INSTANCE=edge ORBITA_DEV_PORT=5313 bun run dev -- --remote-debugging-port=39373
 *   2. 在实例里把要查的面摆出来（开文件面板 / 引用几段话），然后：
 *        node scripts/ui-edges.mjs 39373 5313
 *      参数：CDP 端口、dev 端口（默认 3933 / 5273）。
 *   3. 新检查项加进下面的 CHECKS：row 选出行，trailing 选尾元素，leading 选首元素，
 *      rightPad 是期望的右内边距（px）。找不到元素的面记 skipped（不违规），便于
 *      在同一实例上跑多种会话形态。
 * 通过 = exit 0 并打印各项的实测差值；任何一项超差 = exit 1 并列出。
 */
import { connectCdp } from "./cdp.mjs";

const cdpPort = process.argv[2] ?? "3933";
const devPort = process.argv[3] ?? "5273";

/** 检查集：row = 行；trailing = 静止态尾部元素；leading = 首元素；rightPad = 期望右内边距 */
const CHECKS = [
  {
    name: "Session·附件行：尾部（size / 已不在）钉在右血线",
    row: "section[aria-label='Attachments'] .file-row",
    leading: "span",
    trailing: ".attachment-row-tail",
    rightPad: 12, // var(--space-3)
  },
  {
    name: "引用卡格子：注脚钉在右血线",
    row: ".material-quote-row",
    leading: ".orbita-icon",
    trailing: ".material-quote-note",
    rightPad: 12, // 每条一张卡（2026-10-11）：卡的横向内边距 var(--space-3)
  },
  {
    name: "输入框胶囊：移除键贴胶囊右内边距",
    row: ".material-chip",
    leading: ".orbita-icon",
    trailing: ".material-chip-x",
    rightPad: 4,
  },
  {
    name: "气泡附件回显：目录斜杠在 chip 内部（内容自适应，无悬空尾）",
    row: ".file-ref-chip",
    leading: ".orbita-icon",
    trailing: ".dir-mark-slash",
    // 内容自适应的 chip 没有推右语义：只要求斜杠落在 chip 右内边距（6px）之内，
    // 不像整行那样钉血线；非目录 chip 没有斜杠，跳过不笋违规
    maxInnerGap: 7,
    skipNoTrailing: true,
  },
  {
    name: "文件树行：size 钉在右血线（悬停动作键补位到同一条线）",
    row: ".file-hover-host .file-row",
    leading: ".orbita-icon",
    trailing: ".file-row-meta",
    // .file-row 的右内边距 var(--space-2)；目录行没有 size，跳过
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "PPTX 工具行：用默认应用打开钉在右血线",
    row: ".pptx-toolbar",
    leading: ".pptx-toolbar-title",
    trailing: ".pptx-toolbar-actions",
    // .pptx-toolbar 的横向内边距 var(--space-3)；没有打开 pptx 时跳过
    rightPad: 12,
    skipNoTrailing: true,
  },
  {
    name: "Skills·行：归属点阵钉在右血线",
    row: ".skill-row",
    leading: ".skill-row-main",
    trailing: ".set-dots",
    // .skill-row 的右内边距 var(--space-2)（右栏统一：行内缩在 .panel-list 里）；
    // dim / missing 行没有点阵，跳过。悬停时点阵让位给「选用」键是血线规则的悬停
    // 组合例外，这里量静止态
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "文档面板·挑选列表行：改动时间钉在右血线",
    row: ".dp-picker-row",
    leading: ".orbita-icon",
    trailing: ".dp-picker-age",
    // .dp-picker-row 的左右内边距 var(--space-2)；面板里没有已有文档（挑选列表不出现）时跳过
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "能力面板·行：开关钉在右血线",
    row: ".ability-row",
    leading: ".ability-dot-slot",
    trailing: ".ability-switch",
    // .ability-row 的左右内边距 var(--space-2)（行内缩在 .ability-list 里）；选取态的行、
    // 文件夹不在了的 skill 没有开关，跳过。悬停才出的「插入」压在开关左边、不占位
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "能力面板·组头：开关说明钉在右血线",
    row: ".ability-group-head",
    leading: ".ability-kind",
    trailing: ".ability-group-note",
    // .ability-group-head 的左右内边距 var(--space-2)；选取态组头没有这句，跳过
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "MCP·卡头行：展开键钉在卡右血线",
    // 量卡本身：展开键与状态图标都在卡头那一行（querySelector 取到的第一颗就是它们）。
    // 原先量的是卡头那个 span——它没有内边距，差值恒为 0，这条从来过不了（2026-10-30
    // 能力面板把这张卡挪进详情后第一次真跑到）
    row: ".mcp-card",
    leading: ".orbita-icon",
    trailing: ".mcp-expand",
    // .mcp-card 的横向内边距 var(--space-2)（右栏统一）；没有实例的卡不出展开键，跳过
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "Sub-sessions·收件箱行：相对时间钉在右血线",
    row: ".inbox-row-main",
    leading: ".status-pie",
    trailing: ".inbox-row-ago",
    // .inbox-row-main 的右内边距 var(--space-3)；stopped / idle 行没有竖条，跳过
    rightPad: 12,
    skipNoTrailing: true,
  },
  {
    name: "自动化·行：次数钉在右血线（悬停动作簇绝对定位盖在上面，静止不占位）",
    row: ".auto-row",
    leading: ".auto-ico",
    trailing: ".auto-count",
    // .auto-row 的横向内边距 var(--space-3)；没有运行记录的行次数为空串，元素仍在 DOM
    rightPad: 12,
    skipNoTrailing: true,
  },
  {
    name: "左栏·会话行：「多久没动了」钉在右血线（悬停层的键叠在同一格里，静止不占位）",
    row: ".task-row",
    leading: ".option-row span",
    trailing: ".task-row-age",
    // 静止层 padding-inline-end var(--space-1) = 行首状态槽的左内边距（NavRow 的 padding-left）
    rightPad: 4,
    skipNoTrailing: true,
  },
];

const { evaluate, close } = await connectCdp({ cdpPort, devPort, watchdogMs: 60_000 });

const results = await evaluate(`(() => {
  const checks = ${JSON.stringify(
    CHECKS.map(({ name, row, leading, trailing, rightPad, maxInnerGap, skipNoTrailing }) => ({
      name, row, leading, trailing, rightPad, maxInnerGap, skipNoTrailing,
    })),
  )};
  const out = [];
  for (const c of checks) {
    let rows = [...document.querySelectorAll(c.row)];
    rows = rows.filter((r) => r.offsetParent !== null);
    if (rows.length === 0) { out.push({ name: c.name, status: "skipped", why: "页面上没有这个面" }); continue; }
    const measure = rows.slice(0, 5).map((row) => {
      const rowRect = row.getBoundingClientRect();
      const trailing = row.querySelector(c.trailing);
      const leading = row.querySelector(c.leading);
      if (trailing === null) {
        if (c.skipNoTrailing === true) return { rowText: row.textContent.slice(0, 30), skipped: true };
        return { rowText: row.textContent.slice(0, 30), error: "尾元素不在 DOM" };
      }
      const tRect = trailing.getBoundingClientRect();
      const item = {
        rowText: row.textContent.slice(0, 30),
        trailingRightGap: Math.round(rowRect.right - tRect.right),
      };
      if (leading !== null) item.leadingLeftGap = Math.round(leading.getBoundingClientRect().left - rowRect.left);
      return item;
    });
    out.push({ name: c.name, status: "measured", rightPad: c.rightPad, maxInnerGap: c.maxInnerGap, measure });
  }
  return out;
})()`);

let failed = 0;
for (const r of results ?? []) {
  if (r.status === "skipped") {
    console.log(`- ${r.name}：跳过（${r.why}）`);
    continue;
  }
  for (const m of r.measure ?? []) {
    if (m.skipped) {
      console.log(`- ${r.name}：「${m.rowText}」没有尾部元素，跳过`);
      continue;
    }
    if (m.error) {
      console.log(`✖ ${r.name}：「${m.rowText}」${m.error}`);
      failed++;
      continue;
    }
    if (r.rightPad !== null && r.rightPad !== undefined) {
      const ok = Math.abs(m.trailingRightGap - r.rightPad) <= 1;
      if (!ok) failed++;
      console.log(
        `${ok ? "✓" : "✖"} ${r.name}：「${m.rowText}」尾右差 ${m.trailingRightGap}px（期望 ${r.rightPad}±1）` +
          (m.leadingLeftGap !== undefined ? `，首左差 ${m.leadingLeftGap}px` : ""),
      );
    } else if (r.maxInnerGap !== null && r.maxInnerGap !== undefined) {
      const ok = m.trailingRightGap >= 0 && m.trailingRightGap <= r.maxInnerGap;
      if (!ok) failed++;
      console.log(`${ok ? "✓" : "✖"} ${r.name}：「${m.rowText}」斜杠距右缘 ${m.trailingRightGap}px（应在 0–${r.maxInnerGap}）`);
    }
  }
}
// 列对齐（2026-10-30）：消息列与输入卡同一根外线，正文的字在外线往里一个血线
const column = await evaluate(`(() => {
  const transcript = document.querySelector(".chat-transcript > div");
  const composer = document.querySelector(".composer-card");
  if (transcript === null || composer === null) return null;
  const box = transcript.getBoundingClientRect();
  // 方向 N（2026-11-07）：消息列左侧有一条索引边栏（padding-left: --gutter），「外线」是它的内容盒边缘，
  // 不是列的 border box——输入卡与正文都坐在内容盒里。纸面两档没有边栏，padding 为 0，口径不变
  const style = getComputedStyle(transcript);
  const t = { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) };
  const c = composer.getBoundingClientRect();
  const para = document.querySelector(".assistant-prose .chat-md > *");
  const hem = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-3")) + 1;
  return {
    left: Math.round(c.left - t.left),
    right: Math.round(c.right - t.right),
    prose: para === null ? null : Math.round(para.getBoundingClientRect().left - t.left - hem),
  };
})()`);
if (column === null) {
  console.log("- 列对齐：跳过（页面上没有打开的对话）");
} else {
  for (const [name, gap] of [["输入卡左缘 − 消息列左缘", column.left], ["输入卡右缘 − 消息列右缘", column.right], ["正文首字 − 内线", column.prose]]) {
    if (gap === null) continue;
    const ok = Math.abs(gap) <= 1;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✖"} 列对齐：${name} = ${gap}px（期望 0±1）`);
  }
}

// 右栏入口（2026-10-31，设计系统 readme「Rail entries are grouped」）：
// 按钮在 32px 条里居中；角标右缘不越过条（越过会被条的 overflow 切平）；
// 组间的线比按钮窄、居中，且离上一组末按钮与下一组首按钮一样远。
const railGeometry = await evaluate(`(() => {
  const aside = document.querySelector(".right-rail");
  if (aside === null) return null;
  const a = aside.getBoundingClientRect();
  const mid = (a.left + a.right) / 2;
  const buttons = [...aside.querySelectorAll("button")];
  const widest = Math.max(...buttons.map((b) => b.getBoundingClientRect().width));
  return {
    buttons: buttons.length,
    offCenter: Math.max(...buttons.map((b) => { const r = b.getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - mid); })),
    badgeOver: [...aside.querySelectorAll(".rail-badge")].map((e) => Math.round(e.getBoundingClientRect().right - a.right)),
    seps: [...aside.querySelectorAll(".rail-sep")].map((sep) => {
      const r = sep.getBoundingClientRect();
      const above = sep.previousElementSibling?.lastElementChild?.getBoundingClientRect();
      const below = sep.nextElementSibling?.firstElementChild?.getBoundingClientRect();
      return {
        offCenter: Math.abs((r.left + r.right) / 2 - mid),
        narrower: widest - r.width,
        up: above === undefined ? null : r.top - above.bottom,
        down: below === undefined ? null : below.top - r.bottom,
      };
    }),
  };
})()`);
if (railGeometry === null) {
  console.log("- 右栏入口：跳过（页面上没有右栏）");
} else {
  const checks = [
    ["按钮居中在条里", railGeometry.offCenter <= 0.5, `最大偏差 ${railGeometry.offCenter}px`],
    ["角标右缘不越过条", railGeometry.badgeOver.every((over) => over <= 0), railGeometry.badgeOver.length === 0 ? "页面上没有角标" : `越过 ${railGeometry.badgeOver.join(",")}px`],
    ...railGeometry.seps.map((sep, index) => [
      `第 ${index + 1} 条组间线：居中、比按钮窄、上下留白对称`,
      sep.offCenter <= 0.5 && sep.narrower > 0 && sep.up !== null && sep.down !== null && Math.abs(sep.up - sep.down) <= 1,
      `偏心 ${sep.offCenter}px，窄 ${sep.narrower}px，上 ${sep.up}px / 下 ${sep.down}px`,
    ]),
  ];
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✖"} 右栏入口：${name}（${detail}）`);
  }
}

close();
console.log(failed === 0 ? "血线守卫：全部通过" : `血线守卫：${failed} 处违规`);
process.exit(failed === 0 ? 0 : 1);
