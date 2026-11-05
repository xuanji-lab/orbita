// 两份 result.json 并排成一张表：Mac 对 Windows，或改前对改后。
//   node scripts/bench/compare.mjs <A/result.json> <B/result.json> [--out compare.md]
// 每格「A 中位数 → B 中位数（变化%）」；变化以 A 为基准。两边刻度或动作对不上的行跳过。
// 只比中位数：最差值在各自的 result.md 里看；某一边那格标了「抖」，这里也标出来。
import { readFileSync, writeFileSync } from "node:fs";
import { TABLES, fmt, machineLines } from "./report.mjs";

const [pathA, pathB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!pathA || !pathB) {
  console.error("用法：node scripts/bench/compare.mjs <A/result.json> <B/result.json> [--out compare.md]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const A = JSON.parse(readFileSync(pathA, "utf8"));
const B = JSON.parse(readFileSync(pathB, "utf8"));

const jitter = (s) => s !== undefined && s.n >= 3 && s.median > 0 && s.max > 2 * s.median;
function cell(a, b, d) {
  if (a === undefined && b === undefined) return "—";
  const left = a === undefined ? "—" : fmt(a.median, d) + (jitter(a) ? "抖" : "");
  const right = b === undefined ? "—" : fmt(b.median, d) + (jitter(b) ? "抖" : "");
  const pct = a !== undefined && b !== undefined && a.median !== 0 ? ` (${b.median >= a.median ? "+" : ""}${(((b.median - a.median) / Math.abs(a.median)) * 100).toFixed(0)}%)` : "";
  return `${left} → ${right}${pct}`;
}

const lines = [`# 对照：A = ${A.label} ／ B = ${B.label}`, "", "**A**", ...machineLines(A), "", "**B**", ...machineLines(B), ""];
if (A.fixture.sha256 !== B.fixture.sha256) lines.push("> 注意：两边素材的 sha256 不同，不是同一份会话，数不能直接比。", "");
lines.push("每格「A 中位数 → B 中位数（变化%）」；「抖」= 那一边最差超过中位数两倍。", "");

const tickA = new Map(A.ticks.map((t) => [t.turns, t]));
const common = B.ticks.filter((t) => tickA.has(t.turns));
lines.push("## 冷打开（点击→静止 ms / 最长任务 ms）", "", "| 刻度 | 点击→静止 ms | 最长任务 ms |", "|---|---|---|");
for (const tb of common) {
  const ta = tickA.get(tb.turns);
  const one = (k) => cell(ta.coldOpen?.[k] === undefined ? undefined : { median: ta.coldOpen[k], n: 1 }, tb.coldOpen?.[k] === undefined ? undefined : { median: tb.coldOpen[k], n: 1 }, 0);
  lines.push(`| ${tb.turns} 轮 | ${one("settleMs")} | ${one("r.longMax")} |`);
}
for (const [action, spec] of Object.entries(TABLES)) {
  lines.push("", `## ${spec.title}`, "", `| 刻度 | ${spec.cols.map((c) => c[1]).join(" | ")} |`, `|---|${spec.cols.map(() => "---").join("|")}|`);
  for (const tb of common) {
    const sa = tickA.get(tb.turns).actions[action]?.summary;
    const sb = tb.actions[action]?.summary;
    if (!sa && !sb) continue;
    lines.push(`| ${tb.turns} 轮 | ${spec.cols.map(([k, , d]) => cell(sa?.[k], sb?.[k], d)).join(" | ")} |`);
  }
}
const md = lines.join("\n") + "\n";
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], md);
process.stdout.write(md);
