// 旧会话迁移：pi 本子（coding-agent 0.84.3 JSONL）→ durable 1.5.0 SQLite。
// 相比第一轮（1.4.0 版 03-migrate-session.ts）的改进：
//   compaction head 不再用「id+1」假设——先把 compaction 之后的第一条 entry append 进去、
//   拿到真实 id，再 append CompactionEntry（head 指向它）。模型上下文从最新 head 起，
//   被摘要的 entry 无论在 id 序里位于 marker 之前还是之后都不进上下文。
// 用法：node migrate-durable.mjs <pi-session.jsonl> <out.sqlite>
//   环境变量 DURABLE_ROOT：durable-lab-2 目录（含 node_modules，pi-durable 1.5.0）。
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";

const DURABLE_ROOT = process.env.DURABLE_ROOT;
if (!DURABLE_ROOT) {
  console.error("需要环境变量 DURABLE_ROOT（durable-lab-2 目录，含 pi-durable 1.5.0 的 node_modules）");
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(resolvePkg(DURABLE_ROOT, p)).href);

const { BACKGROUND_CONTEXT } = await mod("@earendil-works/chord/context");
const { createModels } = await mod("@earendil-works/pi-ai/models");
const durable = await mod("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await mod("@earendil-works/pi-durable/storage/sqlite/node");

const context = BACKGROUND_CONTEXT;
const [srcFile, dbFile] = process.argv.slice(2);
if (!srcFile || !dbFile) {
  console.error("用法：node migrate-durable.mjs <pi-session.jsonl> <out.sqlite>");
  process.exit(2);
}

// 模型固定为 mock（bench 里再换真注册的 provider）；迁移本身不需要联网。
const models = createModels();
const registry = durable.createRegistry();
registry.install(durable.defineExtension({ name: "spike-migrate" }));

const lines = readFileSync(srcFile, "utf8").split("\n").filter((l) => l.trim() !== "");
rmSync(dbFile, { force: true });
const t0 = performance.now();
const harness = await durable.Harness.open(await openNodeSqliteStorage(dbFile), { models, registry }, context);
// ROOT_CONVERSATION_ID：与 orbita「每会话一库」的现状对齐（spike 报告 Q1 的 B 总库是正式迁移的事）
const root = await harness.root(context, { agent: { model: { provider: "bench", modelId: "bench-model" } } });

let migrated = 0;
let droppedCustom = 0;
let compactions = 0;
let pendingCompaction = null; // { summary, ts }
let lastTs = Date.now();
const appendCompaction = async (headId, summary, ts) => {
  await root.commit(
    (tx) =>
     	tx.appendEntry(root.id, {
        kind: durable.CompactionEntry.kind,
        head: headId,
        model: [{ role: "user", content: [{ type: "text", text: `[conversation compacted]\n${summary ?? ""}` }], timestamp: ts }],
        data: { reason: "manual" },
      }),
    context,
  );
  compactions += 1;
};

for (const line of lines) {
  const record = JSON.parse(line);
  if (record.type === "message" && record.message) {
    const message = { ...record.message };
    const parsed = record.timestamp !== undefined ? Date.parse(record.timestamp) : Number.NaN;
    if (typeof message.timestamp === "string") message.timestamp = Date.parse(message.timestamp);
    if (typeof message.timestamp !== "number") message.timestamp = Number.isNaN(parsed) ? lastTs : parsed;
    lastTs = message.timestamp;
    const draft = { model: [message], timestamp: message.timestamp };
    let appended;
    if (message.role === "user") appended = await root.commit((tx) => tx.appendEntry(durable.UserEntry, root.id, draft), context);
    else if (message.role === "assistant") appended = await root.commit((tx) => tx.appendEntry(durable.AssistantEntry, root.id, draft), context);
    else if (message.role === "toolResult") appended = await root.commit((tx) => tx.appendEntry(durable.ToolResultEntry, root.id, draft), context);
    else {
      console.warn(`  未知 role=${String(message.role)}，跳过`);
      continue;
    }
    migrated += 1;
    // compaction 的 head 落到「它之后的第一条 entry」的真实 id 上
    if (pendingCompaction !== null) {
      const entryId = appended.id;
      await appendCompaction(entryId, pendingCompaction.summary, pendingCompaction.ts);
      pendingCompaction = null;
    }
  } else if (record.type === "compaction") {
    if (pendingCompaction !== null) {
      // 连续两个 compaction（中间没有 entry）：前一个的 head 只能指向后一条会出现的 entry——
      // 叠起来，head 由后一个 compaction 落地时一起写
      pendingCompaction.summary = `${pendingCompaction.summary}\n${record.summary ?? ""}`;
    } else {
      pendingCompaction = { summary: record.summary ?? "", ts: Date.parse(record.timestamp) || lastTs };
    }
  } else if (record.type === "custom") {
    droppedCustom += 1;
  } else if (record.type === "thinking_level_change") {
    await root.configure({ thinkingLevel: record.thinkingLevel }, context).catch(() => {});
  }
  // session / model_change：会话身份与模型由 pi.agent 文档承载（迁移时固定 mock）
}
if (pendingCompaction !== null) {
  // 文件末尾的 compaction：head 无处可指——1.5.0 里 head:undefined 表示「从头保留」的反义（裁掉全部）
  // 与 pi 语义（其后无内容 = 上下文只剩摘要）一致，直接落地
  await appendCompaction(undefined, pendingCompaction.summary, pendingCompaction.ts);
}

const page = await root.entries({}, 100_000, undefined, context);
const ms = (performance.now() - t0).toFixed(0);
console.log(JSON.stringify({
  srcRecords: lines.length,
  migrated,
  droppedCustom,
  compactions,
  durableEntries: page.items.length,
  ms: Number(ms),
}));
await harness.close(context);
process.exit(0);
