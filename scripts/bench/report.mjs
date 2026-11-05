// 结果 → Markdown 表。bench.mjs 与 compare.mjs 共用同一份列定义，两边的表一定对得上。
// 每格是「中位数（最差）」；5 次里最差超过中位数两倍的标「抖」，不该进结论。

/** 每个动作一张表：列 = [指标键, 表头, 单位换算后的小数位] */
export const TABLES = {
  switch: {
    title: "切到长会话（先停在 1 轮的 bench-home，点侧栏切过去；热切换，冷打开单列）",
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
};

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

export function machineLines(r) {
  const m = r.machine;
  return [
    `- 机器：${m.model}；CPU ${m.cpu}（${m.cores} 核）；内存 ${m.memGB} GB；系统 ${m.os}`,
    `- 屏幕：缩放 ${m.display?.scaleFactor ?? "?"}×，${m.display?.width ?? "?"}×${m.display?.height ?? "?"}，${m.display?.hz ? Math.round(m.display.hz) : "?"} Hz；电源：${m.onBattery === true ? "电池" : m.onBattery === false ? "插电" : "?"}${m.power ? `；${m.power}` : ""}${m.defender ? `；Defender 实时防护 ${m.defender}` : ""}`,
    `- 构建：${r.build.type}；commit ${r.build.commit}${r.build.dirty ? "（有未提交改动）" : ""}；Electron ${r.build.electron}`,
    `- 素材：${r.fixture.name}（sha256 ${r.fixture.sha256.slice(0, 12)}…）；每格 1 次预热 + ${r.config.runs} 次，取中位数（最差）`,
  ];
}

export function renderMarkdown(r) {
  const lines = [`# Orbita 性能基线：${r.label}`, "", `${r.startedAt}`, "", ...machineLines(r), ""];
  lines.push("每格是「中位数（最差）」。「抖」= 最差超过中位数两倍，单看这格不下结论。", "");
  lines.push("## 体量", "", "| 刻度 | 会话 JSONL MB | pi 会话本 MB | 记录数 | 冷打开：点击→静止 ms | 冷打开：最长任务 ms |", "|---|---|---|---|---|---|");
  for (const t of r.ticks) {
    lines.push(`| ${t.turns} 轮 | ${fmt(t.sizes.sessionBytes / 1e6, 1)} | ${fmt(t.sizes.piBytes / 1e6, 1)} | ${t.sizes.records} | ${fmt(t.coldOpen?.settleMs, 0)} | ${fmt(t.coldOpen?.["r.longMax"], 0)} |`);
  }
  for (const [action, spec] of Object.entries(TABLES)) {
    lines.push("", `## ${spec.title}`, "", `| 刻度 | ${spec.cols.map((c) => c[1]).join(" | ")} |`, `|---|${spec.cols.map(() => "---").join("|")}|`);
    for (const t of r.ticks) {
      const s = t.actions[action]?.summary;
      if (!s) continue;
      lines.push(`| ${t.turns} 轮 | ${spec.cols.map(([k, , d]) => cell(s[k], d)).join(" | ")} |`);
    }
  }
  const warn = r.ticks.flatMap((t) => (t.warnings ?? []).map((w) => `- ${t.turns} 轮：${w}`));
  if (warn.length > 0) lines.push("", "## 警告", "", ...warn);
  return lines.join("\n") + "\n";
}
