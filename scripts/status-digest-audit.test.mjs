/**
 * 状态卡摘要的对账（2026-11-27）：真实会话上，旧派生（全量 records 一次算）与新路径
 * （fold 摘要 + 尾窗叠加）逐项深等。
 *
 * 跑法：`ORBITA_STATUS_AUDIT_DIR=<sessions 目录> node --test scripts/status-digest-audit.test.mjs`
 * （`bun run test` 会带上它；没有环境变量就 skip——真实会话数据不进仓）。
 *
 * 对账口径（每条会话）：
 * - 产物：statusOutputs(records, null) vs digestOutputs(fold(records))；
 * - 子会话在跑什么：childActivityOf(records) vs digestChildActivity(fold(records))；
 * - 终端：useLiveTerminals 的 launched 抽取（基线在本文件复刻，它已从组件里删掉）vs digestTerminals；
 * - 目标账：buildGoalLedger(ledgerEventsOf(records)) vs 同一函数跑 fold 的 slim 段；
 * - 计划版本线：planHistory(records) vs planHistory(slim)；
 * - 子会话挂步：delegationSteps(records, planTimeline(records)) vs delegationSteps(slim, planTimeline(slim))；
 * - 尾窗叠加：fold(前 n-120 条) + tailOf 选出的尾巴再折 == fold(全量)（recentIds 护栏一并验）。
 *
 * records = 生效视图（SessionStore.load：逐行解析 + 回退折叠），与卡上旧派生的输入同源。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "../src/main/session/store.ts";
import {
  digestChildActivity,
  digestOutputs,
  digestTerminals,
  foldStatusRecord,
  foldStatusRecords,
  cloneStatusDigestState,
  emptyStatusDigestState,
} from "../src/shared/status-digest.ts";
import { buildGoalLedger } from "../src/shared/goal-ledger.ts";
import { statusOutputs, childActivityOf } from "../src/renderer/src/features/context/chat-status.ts";
import { planHistory, planTimeline } from "../src/renderer/src/features/context/plan-timeline.ts";
import { delegationSteps } from "../src/renderer/src/features/context/delegation-steps.ts";
import { ledgerEventsOf } from "../src/renderer/src/features/context/goal-ledger-records.ts";

const DIR = process.env.ORBITA_STATUS_AUDIT_DIR;

/** useLiveTerminals 删掉前的 launched 抽取（基线；与 shared/status-digest.ts 的 terminals 折对照） */
function baselineTerminals(records) {
  const map = new Map();
  for (const record of records) {
    if (record.role !== "tool" || record.toolName !== "terminal_execute" || record.status !== "complete") continue;
    const text = record.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    const id = /visible terminal (\S+) \(/.exec(text)?.[1];
    const command = record.input?.["command"];
    if (id !== undefined && typeof command === "string") map.set(id, { id, command, since: record.timestamp });
  }
  return [...map.values()];
}

/** tailOf（useStatusDigest.ts）的复刻：尾窗里比摘要新的记录 */
function tailOf(digest, current) {
  const lastId = digest.meta.lastId;
  if (lastId === null) return [...current];
  const at = current.findIndex((record) => record.id === lastId);
  if (at < 0) return [];
  const recent = new Set(digest.meta.recentIds);
  return current.slice(at + 1).filter((record) => !recent.has(record.id));
}

function goalViewOf(records) {
  const ledger = buildGoalLedger(ledgerEventsOf(records));
  return ledger;
}

function compareSession(id, records) {
  const folded = foldStatusRecords(records);
  const diffs = [];
  const check = (name, actual, expected) => {
    try {
      assert.deepStrictEqual(actual, expected);
    } catch {
      diffs.push(name);
    }
  };
  check("outputs", digestOutputs(folded), statusOutputs(records, null));
  check("activity", digestChildActivity(folded), childActivityOf(records));
  check("terminals", digestTerminals(folded), baselineTerminals(records));
  check("goal", goalViewOf(folded.slim), goalViewOf(records));
  check("plan", planHistory(folded.slim), planHistory(records));
  const timeline = planTimeline(records);
  const assignOld = delegationSteps(records, timeline);
  const assignNew = delegationSteps(folded.slim, planTimeline(folded.slim));
  check("delegation", [...assignNew.entries()].sort(), [...assignOld.entries()].sort());

  // 尾窗叠加：折前 n-120 条当摘要，tailOf 选尾巴再折，与全量折深等
  const cut = Math.max(0, records.length - 120);
  const base = foldStatusRecords(records.slice(0, cut));
  const tail = tailOf(base, records);
  const overlaid = cloneStatusDigestState(base);
  for (const record of tail) foldStatusRecord(overlaid, record);
  check("tail-overlay", overlaid, folded);
  return diffs;
}

describe("状态卡摘要 · 真实会话对账", { skip: DIR === undefined || DIR === "" }, () => {
  it("每条会话：fold 与旧派生逐项深等", async () => {
    const store = new SessionStore(DIR);
    const names = (await readdir(DIR)).filter((name) => name.endsWith(".jsonl"));
    assert.ok(names.length > 0, "审计目录里没有会话");
    const failures = [];
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length);
      const detail = await store.load(id);
      if (detail === null) continue;
      const diffs = compareSession(id, detail.transcript);
      if (diffs.length > 0) failures.push(`${id}: ${diffs.join(", ")}`);
    }
    assert.deepStrictEqual(failures, [], `对不上的会话：\n${failures.join("\n")}`);
  });
});
