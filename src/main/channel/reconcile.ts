/**
 * 「通道 running，但主进程没有活轮」的收尾。
 *
 * 终局不是从通道名猜：启动 / phase idle 时读子会话转录尾部，区分正常回答、模型失败与
 * 没有收尾的中断，再追加一条 system 消息。通道仍是唯一真源；重启后不用重复推一遍。
 * 纯模块 + 依赖注入，不 import electron。
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import {
  channelStatus,
  type ChannelEndCause,
  type ChannelKey,
  type ChannelMessage,
  type ChannelStatus,
} from "../../shared/channel.ts";
import {
  failedRunOutcome,
  subSessionRunOutcome,
  subSessionRunRecordOf,
  type SubSessionRunRecord,
} from "../../shared/sub-session-run.ts";
import { isNotFound } from "../fs-errors.ts";
import { headStringField, scanJsonlLines } from "../jsonl-scan.ts";
import type { SessionStore } from "../session/store.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { ChannelStore } from "./store.ts";
import type { ChannelEvent } from "../../shared/agent-ipc.ts";

const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_KEPT_RECORDS = 200;
const STARTUP_CONCURRENCY = 4;

export interface ChannelClosureNotice {
  parentId: string;
  childId: string;
  message: ChannelMessage;
  status: ChannelStatus;
  childWorkbench: string;
}

interface ReconcileOptions {
  /** 启动 = app-exit；agent 进程崩 = process-exit；普通 phase idle = incomplete。 */
  interruptedCause: Extract<ChannelEndCause, "app-exit" | "process-exit" | "incomplete">;
  /** 显式 turn failed 是确定终局，不等 phase idle；也不能再被转录尾部分类覆盖。 */
  failureText?: string;
  /** 启动时尚没有 renderer 订阅：收集通知，第一次 channel:list 后再补播。 */
  deferBroadcast?: boolean;
  force?: boolean;
}

export interface ChannelReconcilerDeps {
  sessions: Pick<SessionStore, "list" | "readMeta" | "recordPath" | "workbenchPath">;
  channels: Pick<ChannelStore, "load" | "append">;
  phases: Map<string, SessionPhase>;
  broadcast: (event: ChannelEvent) => void;
  now?: () => number;
  newId?: () => string;
}

export class ChannelReconciler {
  private readonly deps: ChannelReconcilerDeps;
  private readonly chains = new Map<string, Promise<ChannelClosureNotice | null>>();

  constructor(deps: ChannelReconcilerDeps) {
    this.deps = deps;
  }

  /** 启动扫全部子会话；只碰仍为 running 且没有活轮的通道。 */
  async reconcileAll(): Promise<ChannelClosureNotice[]> {
    const metas = (await this.deps.sessions.list()).filter((meta) => meta.parentId !== undefined);
    const queue = [...metas];
    const notices: ChannelClosureNotice[] = [];
    const worker = async (): Promise<void> => {
      for (let meta = queue.shift(); meta !== undefined; meta = queue.shift()) {
        try {
          // 列表里已经有 meta：传进去，免得每个子会话再读一遍 meta 文件（Windows 上 1000+ 次小文件读）
          const notice = await this.reconcileSession(
            meta.id,
            { interruptedCause: "app-exit", deferBroadcast: true },
            meta,
          );
          if (notice !== null) notices.push(notice);
        } catch (cause) {
          // 一条坏会话不能拖垮启动；账本没读到就不编结束态，下次启动再试。
          console.error("[channel] 子会话启动收尾失败", meta.id, cause);
        }
      }
    };
    await Promise.all(Array.from({ length: STARTUP_CONCURRENCY }, () => worker()));
    return notices.sort((a, b) => a.message.createdAt - b.message.createdAt);
  }

  /** 同一子会话串行，避免 phase idle / failed / 启动清扫并发追加两条终局。 */
  reconcileSession(
    childId: string,
    options: ReconcileOptions,
    /** 调用方手里已有的 meta（启动全扫）；缺省现读。只用它的 parentId——父子关系建后不变 */
    known?: Pick<SessionMeta, "parentId">,
  ): Promise<ChannelClosureNotice | null> {
    const previous = this.chains.get(childId) ?? Promise.resolve(null);
    const pending = previous.catch(() => null).then(() => this.reconcileNow(childId, options, known));
    this.chains.set(childId, pending);
    const cleanup = (): void => {
      if (this.chains.get(childId) === pending) this.chains.delete(childId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private async reconcileNow(
    childId: string,
    options: ReconcileOptions,
    known?: Pick<SessionMeta, "parentId">,
  ): Promise<ChannelClosureNotice | null> {
    const meta = known ?? (await this.deps.sessions.readMeta(childId));
    if (meta === null || meta.parentId === undefined) return null;
    if (options.force !== true && this.isActive(childId)) return null;
    const key: ChannelKey = { parentId: meta.parentId, childId };
    const before = await this.deps.channels.load(key);
    if (channelStatus(before) !== "running") return null;

    const outcome =
      options.failureText !== undefined
        ? failedRunOutcome(options.failureText)
        : subSessionRunOutcome(await readRunTail(this.deps.sessions.recordPath(childId)), options.interruptedCause);

    // 读尾窗是一次异步窗口：用户可能正好点了重试。落账前再查活 phase 与账本，不能关掉新轮。
    if (options.force !== true && this.isActive(childId)) return null;
    const latest = await this.deps.channels.load(key);
    if (channelStatus(latest) !== "running") return null;
    const message: ChannelMessage = {
      id: (this.deps.newId ?? randomUUID)(),
      from: "child",
      author: "system",
      kind: outcome.kind,
      text: closureText(outcome.text, outcome.endCause),
      delivery: "followUp",
      createdAt: (this.deps.now ?? Date.now)(),
      endCause: outcome.endCause,
    };
    // 单条 append 不重写历史：进程中断最多留下最后一个半截行，load 会跳过，旧账不被撕裂。
    await this.deps.channels.append(key, message);
    const notice: ChannelClosureNotice = {
      parentId: key.parentId,
      childId,
      message,
      status: channelStatus([...latest, message]),
      childWorkbench: this.deps.sessions.workbenchPath(childId),
    };
    if (options.deferBroadcast !== true) this.broadcast(notice);
    return notice;
  }

  private isActive(sessionId: string): boolean {
    const phase = this.deps.phases.get(sessionId);
    return phase !== undefined && phase !== "idle";
  }

  private broadcast(notice: ChannelClosureNotice): void {
    this.deps.broadcast({
      type: "message",
      parentId: notice.parentId,
      childId: notice.childId,
      message: notice.message,
      childWorkbench: notice.childWorkbench,
    });
    this.deps.broadcast({
      type: "status",
      parentId: notice.parentId,
      childId: notice.childId,
      status: notice.status,
    });
  }
}

/** 给模型看的正文要自描述；界面优先读 endCause，不会把这行英文当作用户可见分类。 */
function closureText(detail: string, cause: ChannelEndCause): string {
  if (detail !== "") return detail;
  switch (cause) {
    case "completed":
      return "The sub-session's answer ended normally, but it did not call report_to_parent.";
    case "app-exit":
      return "The application exited before the sub-session's turn settled.";
    case "process-exit":
      return "The agent process exited before the sub-session's turn settled.";
    case "aborted":
      return "The sub-session's turn was interrupted before it settled.";
    case "model":
      return "The model returned an error.";
    default:
      return "The sub-session's turn ended without a final answer.";
  }
}

/**
 * 只读文件尾；起点可能落在一条大行中间，第一行 JSON.parse 失败会跳过，下一行恢复。
 * 尾部一条有效记录都没有时才从 0 流式回扫（例如异常大的 file-turn 把最后回答挤出了窗口）。
 */
async function readRunTail(path: string): Promise<SubSessionRunRecord[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const records = await scanRange(path, start);
  return records.length === 0 && start > 0 ? scanRange(path, 0) : records;
}

async function scanRange(path: string, start: number): Promise<SubSessionRunRecord[]> {
  const records: SubSessionRunRecord[] = [];
  await scanJsonlLines(
    path,
    (head) => {
      const role = headStringField(head, "role");
      return role === undefined || role === "assistant" || role === "tool" || role === "user" || role === "channel-mark";
    },
    (line) => {
      try {
        const record = subSessionRunRecordOf(JSON.parse(line));
        if (record === null) return;
        records.push(record);
        if (records.length > MAX_KEPT_RECORDS) records.shift();
      } catch {
        // 半截行 / 大行起点：跳过，后面的完整行照常恢复。
      }
    },
    undefined,
    { start },
  );
  return records;
}
