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
    name: "MCP·卡头行：展开键钉在卡右血线",
    row: ".mcp-card > span:first-of-type",
    leading: ".orbita-icon",
    trailing: ".mcp-expand",
    // .mcp-card 的横向内边距 var(--space-2)（右栏统一）；没有实例的卡不出展开键，跳过
    rightPad: 8,
    skipNoTrailing: true,
  },
  {
    name: "Sub-sessions·收件箱行：相对时间钉在右血线",
    row: ".inbox-row-main",
    leading: ".status-bar",
    trailing: ".inbox-row-ago",
    // .inbox-row-main 的右内边距 var(--space-3)；stopped / idle 行没有竖条，跳过
    rightPad: 12,
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
close();
console.log(failed === 0 ? "血线守卫：全部通过" : `血线守卫：${failed} 处违规`);
process.exit(failed === 0 ? 0 : 1);
