// 两份 result.json 并排成一张表：Mac 对 Windows，或改前对改后。
//   node scripts/bench/compare.mjs <A/result.json> <B/result.json> [--out compare.md]
// 每格「A 中位数 → B 中位数（变化%）」；变化以 A 为基准。刻度按「素材·刻度」配对（v1 结果按轮数），对不上的跳过。
// 只比中位数：最差值在各自的 result.md 里看；某一边那格标了「抖」，这里也标出来。
import { readFileSync, writeFileSync } from "node:fs";
import { CONC_TABLES, LOAD_COLS, PRE_POST, TABLES, fmt, machineLines, rowName, tickKey } from "./report.mjs";

const [pathA, pathB] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith(".md"));
if (!pathA || !pathB) {
  console.error("用法：node scripts/bench/compare.mjs <A/result.json> <B/result.json> [--out compare.md]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const A = JSON.parse(readFileSync(pathA, "utf8"));
const B = JSON.parse(readFileSync(pathB, "utf8"));

const jitter = (s) => s !== undefined && s.n >= 3 && s.median > 0 && s.max > 2 * s.median;
const one = (v) => (v === undefined || v === null ? undefined : { median: v, n: 1 });
function cell(a, b, d) {
  if (a === undefined && b === undefined) return "—";
  const left = a === undefined ? "—" : fmt(a.median, d) + (jitter(a) ? "抖" : "");
  const right = b === undefined ? "—" : fmt(b.median, d) + (jitter(b) ? "抖" : "");
  const pct = a !== undefined && b !== undefined && a.median !== 0 ? ` (${b.median >= a.median ? "+" : ""}${(((b.median - a.median) / Math.abs(a.median)) * 100).toFixed(0)}%)` : "";
  return `${left} → ${right}${pct}`;
}

const lines = [`# 对照：A = ${A.label} ／ B = ${B.label}`, "", "**A**", ...machineLines(A), "", "**B**", ...machineLines(B), ""];
const shaOf = (r) => new Map((r.fixtures ?? [r.fixture]).map((f) => [f.name, f.sha256]));
const shaA = shaOf(A);
for (const [name, sha] of shaOf(B)) {
  if (shaA.has(name) && shaA.get(name) !== sha) lines.push(`> 注意：素材 ${name} 两边的 sha256 不同，不是同一份会话，这一素材的数不能直接比。`, "");
}
lines.push("每格「A 中位数 → B 中位数（变化%）」；「抖」= 那一边最差超过中位数两倍。", "");

const tickA = new Map(A.ticks.map((t) => [tickKey(t), t]));
const common = B.ticks.filter((t) => tickA.has(tickKey(t)));
const table = (title, cols, get) => {
  const rows = common.map((tb) => [tb, tickA.get(tickKey(tb))]).filter(([tb, ta]) => cols.some(([k]) => get(ta, k) || get(tb, k)));
  if (rows.length === 0) return;
  lines.push("", `## ${title}`, "", `| 刻度 | ${cols.map((c) => c[1]).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const [tb, ta] of rows) lines.push(`| ${rowName(tb)} | ${cols.map(([k, , d]) => cell(get(ta, k), get(tb, k), d)).join(" | ")} |`);
};
table("冷打开", [["settleMs", "点击→静止 ms", 0], ["r.longMax", "最长任务 ms", 0]], (t, k) => one(t.coldOpen?.[k]));
table("打开时传多少、读一遍多久", LOAD_COLS, (t, k) => one(t.load?.[k]));
for (const [action, spec] of Object.entries(TABLES)) table(spec.title, spec.cols, (t, k) => t.actions[action]?.summary?.[k]);
for (const [phase, name] of PRE_POST.phases) table(`${PRE_POST.title}：${name}`, PRE_POST.cols, (t, k) => t.actions[phase]?.summary?.[k]);

// 并发场景：按「子会话体量 · K」配对
if (A.concurrency && B.concurrency) {
  const rowsOf = (r) => new Map(r.concurrency.sizes.flatMap((s) => Object.entries(s.rows).map(([K, row]) => [`${s.label} · K=${K}`, row])));
  const ra = rowsOf(A), rb = rowsOf(B);
  const kidCols = CONC_TABLES.children.pairs.flatMap(([m, x, name]) => [[m, `子会话${name}（中位）`, 0], [x, `子会话${name}（最差）`, 0]]);
  for (const [key, title, cols] of [["typing", CONC_TABLES.typing.title, CONC_TABLES.typing.cols], ["typing", CONC_TABLES.children.title, kidCols], ["mother", CONC_TABLES.mother.title, CONC_TABLES.mother.cols]]) {
    const names = [...rb.keys()].filter((n) => ra.has(n) && rb.get(n)[key]?.summary);
    if (!names.length) continue;
    lines.push("", `## 并发：${title}`, "", `| 子会话 · 条数 | ${cols.map((c) => c[1]).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    for (const n of names) lines.push(`| ${n} | ${cols.map(([k, , d]) => cell(ra.get(n)[key]?.summary?.[k], rb.get(n)[key]?.summary?.[k], d)).join(" | ")} |`);
  }
}

const md = lines.join("\n") + "\n";
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], md);
process.stdout.write(md);
