/**
 * 会话库的 bash 使用统计（2026-10-18，为工具选型提示词提供可复算的数字）。
 *
 * 问题：grep / find / ls 这些专用工具补上之后（10-04），模型仍然大量用 bash 跑
 * grep / cat / sed -n。工具在，不等于模型知道何时用——这个脚本量「bash 里搜索 / 查看类
 * 命令占全部 bash 调用的比例」，按时间分段看提示词改动前后的走向。
 *
 * 用法：
 *   node scripts/tool-usage-stats.mjs [sessionsDir] [--cutoff YYYY-MM-DD]
 *
 * sessionsDir 默认取 %APPDATA%\orbita\sessions（macOS 是 ~/Library/Application Support/orbita/sessions）。
 * cutoff 默认 2026-10-04（grep/find/ls 内建工具合入的日期）——用来把调用切成「修复前 / 修复后」
 * 两段，同一批会话里做前后对照。
 *
 * 数据来源：每个 *.jsonl 一行一条记录；取 role==="assistant" 的 content 里 type==="toolCall"
 * 的块。bash 命令按管道 / && / ; 切段、跳过 cd / export 这类不干活的段、取首个子命令，
 * 归到 grep/rg/find/fd/ls/dir/cat/head/tail/type 或带 -n 的 sed 的算「搜索 / 查看」。
 * 切段不解析引号（统计用，粗糙可接受）——命令里带引号的管道会被多切几段，只会略微高估。
 *
 * 这个脚本的纯函数（splitSegments / firstCommand / isSearchOrView / bashCallsOf / …）在
 * ./tool-usage-stats.test.mjs 里测；直接 `node` 跑时才读盘。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** grep/find/ls 内建工具合入 main 的日期（feat(agent): 搜索交给 ripgrep/fd） */
export const DEFAULT_CUTOFF = "2026-10-04";

/** 有专用工具（grep / find / ls / read）却仍走 bash 的命令：命中即算「搜索 / 查看」 */
const SEARCH_VIEW_BINARIES = new Set([
  "grep",
  "rg",
  "find",
  "fd",
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "type", // Windows `type file`：与 ls/cat 同义
]);

/** 不干活的段：只是切目录 / 设环境变量，取首个子命令时要跳过（cd X / export K=V） */
const NOOP_SEGMENT_HEADS = new Set(["cd", "pushd", "popd", "export", "set"]);

function baseName(token) {
  const parts = token.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * 把一条 bash 命令切成独立段：管道（|）、与/或（&& / ||）、分号、换行都断开。
 * 不处理引号内的分隔符——统计用途下可接受。
 */
export function splitSegments(command) {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/**
 * 取一段里的首个实义命令（小写、只留末段路径）。跳过 cd / export 这类不产生结果的段头。
 * 全是不干活的段（例如只有 `cd foo`）→ 返回空串，调用方按「不是搜索 / 查看」计。
 */
export function firstCommand(segment) {
  const tokens = segment.split(/\s+/).filter((token) => token !== "");
  let i = 0;
  while (i < tokens.length) {
    const head = baseName(tokens[i]);
    if (NOOP_SEGMENT_HEADS.has(head)) {
      i += 2; // 命令 + 它的参数（cd X / export K=V）
      continue;
    }
    return head;
  }
  return "";
}

/**
 * 这条 bash 命令里有没有「搜索 / 查看」类段：grep/rg/find/fd/ls/dir/cat/head/tail/type，
 * 或带 `-n` 的 sed（`sed -n '1,5p' f` 是 read 的活）。
 */
export function isSearchOrView(command) {
  for (const segment of splitSegments(command)) {
    const head = firstCommand(segment);
    if (head === "") continue;
    if (SEARCH_VIEW_BINARIES.has(head)) return true;
    if (head === "sed" && /(^|\s)-n(\s|$)/.test(segment)) return true;
  }
  return false;
}

/** 解析一份 *.jsonl 文本；坏行（半截 / 非 JSON）跳过。 */
export function parseSessionJsonl(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 半截行（进程被杀写一半）跳过，不让一条坏行废掉整份会话
    }
  }
  return records;
}

/** 按工具名统计全部 toolCall（role==="assistant" 的 content 里的 type==="toolCall"）。 */
export function toolCallCounts(records) {
  const counts = new Map();
  for (const record of records) {
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (block?.type !== "toolCall" || typeof block.toolName !== "string") continue;
      counts.set(block.toolName, (counts.get(block.toolName) ?? 0) + 1);
    }
  }
  return counts;
}

/** 全部 bash 调用（带 timestamp，采不到时间戳为 null）。input.command 非字符串的跳过。 */
export function bashCallsOf(records) {
  const calls = [];
  for (const record of records) {
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (block?.type !== "toolCall" || block.toolName !== "bash") continue;
      const command = block.input?.command;
      if (typeof command !== "string") continue;
      calls.push({
        timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
        command,
      });
    }
  }
  return calls;
}

/** bash 里各「搜索 / 查看」子命令出现次数（grep / cat / sed -n …），用于细分定位。 */
export function searchViewBreakdown(calls) {
  const counts = new Map();
  for (const call of calls) {
    for (const segment of splitSegments(call.command)) {
      const head = firstCommand(segment);
      const key = head === "sed" && /(^|\s)-n(\s|$)/.test(segment) ? "sed -n" : head;
      if (SEARCH_VIEW_BINARIES.has(head) || key === "sed -n") {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * 按 cutoff 分三段统计：全部 / cutoff 之前 / cutoff 之后。
 * `pct` 是搜索 / 查看占该段 bash 调用的百分比；该段没有 bash 调用时为 null。
 */
export function summarizeByPeriod(calls, cutoffMs) {
  const bucketOf = (subset) => {
    const searchView = subset.filter((call) => isSearchOrView(call.command)).length;
    return {
      total: subset.length,
      searchView,
      pct: subset.length === 0 ? null : (searchView / subset.length) * 100,
    };
  };
  return {
    all: bucketOf(calls),
    before: bucketOf(calls.filter((call) => call.timestamp !== null && call.timestamp < cutoffMs)),
    after: bucketOf(calls.filter((call) => call.timestamp !== null && call.timestamp >= cutoffMs)),
  };
}

function sessionsDir(explicit) {
  if (explicit !== null) return explicit;
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData !== "") return join(appData, "orbita", "sessions");
  return join(homedir(), "Library", "Application Support", "orbita", "sessions");
}

/**
 * 解析 CLI 参数：位置参数是 sessionsDir（可选），`--cutoff YYYY-MM-DD`（`--cutoff=…` 也认）。
 * 单独导出是为了测：直接按下标取位置参数会把 `--cutoff` 的值当成目录。
 */
export function parseArgs(argv) {
  let dir = null;
  let cutoff = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cutoff") {
      cutoff = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith("--cutoff=")) {
      cutoff = arg.slice("--cutoff=".length);
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (dir === null) dir = arg;
  }
  return { dir, cutoff };
}

function cutoffMsFrom(raw) {
  const label = raw === null ? DEFAULT_CUTOFF : raw;
  const parsed = Date.parse(`${label}T00:00:00`);
  if (Number.isNaN(parsed)) {
    console.error(`--cutoff 读不懂："${label}"（要 YYYY-MM-DD）`);
    process.exit(2);
  }
  return { label, ms: parsed };
}

function pct(value) {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const dir = sessionsDir(args.dir);
  const cutoff = cutoffMsFrom(args.cutoff);

  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch (cause) {
    console.error(`读不到会话目录 ${dir}：${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }

  const records = [];
  for (const file of files) {
    try {
      records.push(...parseSessionJsonl(readFileSync(join(dir, file), "utf8")));
    } catch (cause) {
      console.error(`跳过 ${file}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const counts = toolCallCounts(records);
  const calls = bashCallsOf(records);
  const summary = summarizeByPeriod(calls, cutoff.ms);
  const breakdown = [...searchViewBreakdown(calls).entries()].sort((a, b) => b[1] - a[1]);

  console.log(`会话目录: ${dir}`);
  console.log(`会话文件: ${files.length}  toolCall 总数: ${[...counts.values()].reduce((a, b) => a + b, 0)}`);
  const toolList = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log("  按工具: " + toolList.map(([name, n]) => `${name}=${n}`).join(" "));
  console.log(`bash 调用: ${summary.all.total}  搜索/查看类: ${summary.all.searchView} (${pct(summary.all.pct)})`);
  console.log("  搜索/查看细分: " + (breakdown.length === 0 ? "（无）" : breakdown.map(([k, v]) => `${k}=${v}`).join(" ")));
  console.log(`分段（cutoff ${cutoff.label}）:`);
  console.log(`  之前: bash=${summary.before.total} 搜索/查看=${summary.before.searchView} (${pct(summary.before.pct)})`);
  console.log(`  之后: bash=${summary.after.total} 搜索/查看=${summary.after.searchView} (${pct(summary.after.pct)})`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
