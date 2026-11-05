// 结果 → Markdown 表。bench.mjs 与 compare.mjs 共用同一份列定义，两边的表一定对得上。
// 每格是「中位数（最差）」；最差超过中位数两倍的标「抖」，不该进结论。

/** 每个动作一张表：列 = [指标键, 表头, 小数位] */
export const TABLES = {
  switch: {
    title: "切到长会话（先停在一问一答的 bench-home，点侧栏切过去；热切换，冷打开在体量表）",
    cols: [
      ["settleMs", "点击→界面静止 ms", 0],
      ["r.longMax", "renderer 最长任务 ms", 0],
      ["r.longSum", "renderer 长任务合计 ms", 0],
      ["r.cpuS", "renderer CPU 秒", 2],
      ["r.heapMB", "renderer JS 堆 MB", 0],
      ["main.cpuS", "主进程 CPU 秒", 2],
      ["main.eldMax", "主进程 ELD 最大 ms", 0],
      ["gpu.cpuS", "GPU 进程 CPU 秒", 2],
    ],
  },
  turn: {
    title: "跑一轮（300 token、50 tok/s、首字 300 ms、2 次 read 工具，每次读 8 KB）",
    cols: [
      ["enterToReqMs", "回车→假模型收到请求 ms", 0],
      ["reqMB", "请求体 MB", 1],
      ["toolGapMs", "每次工具往返额外 ms", 0],
      ["firstTokenMs", "回车→首字上屏 ms", 0],
      ["r.longMax", "renderer 最长任务 ms", 0],
      ["r.over50", "renderer >50ms 帧数", 0],
      ["r.cpuS", "renderer CPU 秒", 2],
      ["main.cpuS", "主进程 CPU 秒", 2],
      ["main.eldMax", "主进程 ELD 最大 ms", 0],
      ["agent.cpuS", "agent CPU 秒", 2],
      ["agent.wsPeakMB", "agent 工作集峰值 MB", 0],
      ["agent.eldMax", "agent ELD 最大 ms", 0],
    ],
  },
  type: {
    title: "流式输出时在输入框打字（400 token 流式期间敲 40 个字符，每 100 ms 一个）",
    cols: [
      ["keyP95", "按键→下一帧 p95 ms", 0],
      ["keyMax", "按键→下一帧 最大 ms", 0],
      ["keyOver50", "按键 >50ms 个数", 0],
      ["r.longMax", "renderer 最长任务 ms", 0],
      ["r.over50", "renderer >50ms 帧数", 0],
      ["r.cpuS", "renderer CPU 秒", 2],
      ["main.cpuS", "主进程 CPU 秒", 2],
      ["gpu.cpuS", "GPU 进程 CPU 秒", 2],
    ],
  },
  idle: {
    title: "空闲 8 秒（长会话开着、什么都不做；探针本身的开销也在这里）",
    cols: [
      ["r.cpuS", "renderer CPU 秒", 2],
      ["main.cpuS", "主进程 CPU 秒", 2],
      ["agent.cpuS", "agent CPU 秒", 2],
      ["gpu.cpuS", "GPU 进程 CPU 秒", 2],
      ["r.wsMB", "renderer 工作集 MB", 0],
      ["main.wsMB", "主进程工作集 MB", 0],
      ["agent.wsMB", "agent 工作集 MB", 0],
      ["r.frames", "8 秒内帧数", 0],
    ],
  },
  compact: {
    title: "压缩那一轮（同「跑一轮」，但正文回复报 170 万输入 token，pi 在轮末自动压缩；假模型回摘要固定等 2 秒）",
    cols: [
      ["compactTotalMs", "正文结束→界碑落盘 ms", 0],
      ["summaryPrepMs", "正文结束→摘要请求到达 ms", 0],
      ["summaryN", "摘要请求个数", 0],
      ["summaryMB", "摘要请求体 MB", 1],
      ["summaryDoneToMarkerMs", "摘要回完→界碑落盘 ms", 0],
      ["r.longMax", "renderer 最长任务 ms", 0],
      ["r.cpuS", "renderer CPU 秒", 2],
      ["main.eldMax", "主进程 ELD 最大 ms", 0],
      ["agent.cpuS", "agent CPU 秒", 2],
      ["agent.wsPeakMB", "agent 工作集峰值 MB", 0],
      ["agent.eldMax", "agent ELD 最大 ms", 0],
    ],
  },
};

/** 压缩前后对照：同一实例里压缩前一轮 vs 压缩后第 1 / 3 轮（都是「跑一轮」的同一份工作量） */
export const PRE_POST = {
  title: "压缩前后的「跑一轮」（同一实例：压缩前一轮 → 压缩 → 压缩后第 1、3 轮）",
  cols: [
    ["enterToReqMs", "回车→请求 ms", 0],
    ["reqMB", "请求体 MB", 1],
    ["toolGapMs", "工具往返额外 ms", 0],
    ["agent.wsPeakMB", "agent 工作集峰值 MB", 0],
    ["agent.eldMax", "agent ELD 最大 ms", 0],
    ["r.cpuS", "renderer CPU 秒", 2],
  ],
  phases: [["compactPre", "前"], ["compactPost1", "后1"], ["compactPost3", "后3"]],
};

export const LOAD_COLS = [
  ["loadIpcMs", "session:load 耗时 ms", 0],
  ["windowRecords", "尾窗条数", 0],
  ["totalRecords", "全量条数", 0],
  ["windowMB", "尾窗 MB", 1],
  ["compactedInWindow", "尾窗里的压缩界碑", 0],
  ["domNodes", "DOM 节点", 0],
  ["mainReadMs", "主进程读文件 ms", 0],
  ["mainParseMs", "主进程逐行解析 ms", 0],
  ["agentReadMs", "agent 读 pi 会话本 ms", 0],
  ["agentParseMs", "agent 逐行解析 ms", 0],
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 一组 run（每个是扁平指标对象）→ 每个指标的 {median,min,max,n}，null / 缺失的样本不计 */
export function summarize(runs) {
  const keys = new Set(runs.flatMap((r) => Object.keys(r)));
  const out = {};
  for (const k of keys) {
    const xs = runs.map((r) => r[k]).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (xs.length > 0) out[k] = { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
  }
  return out;
}

export const fmt = (v, d) => (v === undefined || v === null ? "—" : Number(v).toFixed(d));

/** 「中位数（最差）」；越大越差，所以最差就是 max。抖动大的标出来 */
export function cell(s, d) {
  if (s === undefined) return "—";
  const jitter = s.n >= 3 && s.median > 0 && s.max > 2 * s.median && s.max - s.median > 10 ** -d * 5;
  return `${fmt(s.median, d)}（${fmt(s.max, d)}）${jitter ? " 抖" : ""}`;
}

/** 行名：v1 结果只有轮数；v2 是「素材·刻度」加轮数与压缩次数 */
export const rowName = (t) => (t.label ? `${t.label}（${t.turns} 轮 / ${t.compactions} 压缩）` : `${t.turns} 轮`);
export const tickKey = (t) => t.label ?? `6df79261·${t.turns}`;

export function machineLines(r) {
  const m = r.machine;
  const fixtures = r.fixtures ?? [r.fixture];
  return [
    `- 机器：${m.model}；CPU ${m.cpu}（${m.cores} 核）；内存 ${m.memGB} GB；系统 ${m.os}`,
    `- 屏幕：缩放 ${m.display?.scaleFactor ?? "?"}×，${m.display?.width ?? "?"}×${m.display?.height ?? "?"}，${m.display?.hz ? Math.round(m.display.hz) : "?"} Hz；电源：${m.onBattery === true ? "电池" : m.onBattery === false ? "插电" : "?"}${m.power ? `；${m.power}` : ""}${m.defender ? `；Defender 实时防护 ${m.defender}` : ""}`,
    `- 构建：${r.build.type}；commit ${r.build.commit}${r.build.dirty ? "（有未提交改动）" : ""}；Electron ${r.build.electron}`,
    `- 素材：${fixtures.map((f) => `${f.name}（sha256 ${f.sha256.slice(0, 12)}…）`).join("、")}`,
    `- 次数：每格 1 次预热 + ${r.config.runs} 次${r.config.runsBig ? `（会话文件 >30 MB 的格 ${Math.min(r.config.runs, r.config.runsBig)} 次）` : ""}，取中位数（最差）${r.config.compactReps ? `；压缩场景 ${r.config.compactReps} 次，每次一个新实例` : ""}`,
  ];
}

export function renderMarkdown(r) {
  const lines = [`# Orbita 性能基线：${r.label}`, "", `${r.startedAt}${r.finishedAt ? ` → ${r.finishedAt}` : ""}`, "", ...machineLines(r), ""];
  lines.push("每格是「中位数（最差）」。「抖」= 最差超过中位数两倍，单看这格不下结论。", "");
  lines.push("## 体量与冷打开", "", "| 刻度 | 会话 JSONL MB | pi 会话本 MB | 记录数 | 每格次数 | 冷打开：点击→静止 ms | 冷打开：最长任务 ms |", "|---|---|---|---|---|---|---|");
  for (const t of r.ticks) {
    if (!t.sizes) continue;
    lines.push(`| ${rowName(t)} | ${fmt(t.sizes.sessionBytes / 1e6, 1)} | ${fmt(t.sizes.piBytes / 1e6, 1)} | ${t.sizes.records} | ${t.runs ?? r.config.runs} | ${fmt(t.coldOpen?.settleMs, 0)} | ${fmt(t.coldOpen?.["r.longMax"], 0)} |`);
  }
  if (r.ticks.some((t) => t.load)) {
    lines.push("", "## 打开时传多少、读一遍多久（各 3 次取中位数；读与解析是同进程同文件的模拟，不是原函数）", "", `| 刻度 | ${LOAD_COLS.map((c) => c[1]).join(" | ")} |`, `|---|${LOAD_COLS.map(() => "---").join("|")}|`);
    for (const t of r.ticks) if (t.load) lines.push(`| ${rowName(t)} | ${LOAD_COLS.map(([k, , d]) => fmt(t.load[k], d)).join(" | ")} |`);
  }
  for (const [action, spec] of Object.entries(TABLES)) {
    if (!r.ticks.some((t) => t.actions[action]?.summary)) continue;
    lines.push("", `## ${spec.title}`, "", `| 刻度 | ${spec.cols.map((c) => c[1]).join(" | ")} |`, `|---|${spec.cols.map(() => "---").join("|")}|`);
    for (const t of r.ticks) {
      const s = t.actions[action]?.summary;
      if (s) lines.push(`| ${rowName(t)} | ${spec.cols.map(([k, , d]) => cell(s[k], d)).join(" | ")} |`);
    }
  }
  if (r.ticks.some((t) => t.actions.compactPre?.summary)) {
    lines.push("", `## ${PRE_POST.title}`, "", "每格「前 → 后1 → 后3」，均为中位数。", "", `| 刻度 | ${PRE_POST.cols.map((c) => c[1]).join(" | ")} |`, `|---|${PRE_POST.cols.map(() => "---").join("|")}|`);
    for (const t of r.ticks) {
      if (!t.actions.compactPre?.summary) continue;
      const cells = PRE_POST.cols.map(([k, , d]) => PRE_POST.phases.map(([p]) => fmt(t.actions[p]?.summary[k]?.median, d)).join(" → "));
      lines.push(`| ${rowName(t)} | ${cells.join(" | ")} |`);
    }
  }
  const warn = r.ticks.flatMap((t) => (t.warnings ?? []).map((w) => `- ${t.label ?? `${t.turns} 轮`}：${w}`));
  if (warn.length > 0) lines.push("", "## 警告", "", ...warn);
  return lines.join("\n") + "\n";
}
