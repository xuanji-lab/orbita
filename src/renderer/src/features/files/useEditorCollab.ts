/**
 * 「agent 写文件时标签只读 / 回合结束从磁盘重载 / 按块撤销」的接线层。
 *
 * 读的是**已有的**两条通道，不加新 IPC：
 * - 写入集与回合边界来自 `session.transcript` 与 `session.phase`（pi 的工具调用块 +
 *   agent 事件翻出来的阶段），判断逻辑在 editor-collab.ts（可单测）。
 * - 回合结束时读一次盘走既有的 `api.files.read`（与预览同一条白名单），把重载交给
 *   TexEditorPane 的 `syncFromDisk`——干净就静默重载，脏就走既有的冲突条。
 *
 * **快照只存在于挂着的编辑器上**：盘上的版本随时可读，而「回合开始时用户眼前是哪一版」
 * 只有活着的 CodeMirror 知道。所以快照按登记表（FilesPanel 的 editorsRef）走，不按
 * 「激活标签」走——布局 B 里并排显示的主文件可能不是激活标签。回合中途切到别的标签
 * 也算一次快照：那一版就是用户看到的那一版。
 *
 * 本轮开始时文件是脏的（用户有未保存改动）就不生成改动块：那种情况下 diff 里混着
 * 用户自己的字，按块撤销会把它们一起撤掉。冲突条已经在管这件事。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { FileListRequest } from "@shared/files";
import { api } from "../../api.ts";
import type { ChatSession } from "../chat/useChatSession.ts";
import type { TexEditorHandle } from "./TexEditorPane.tsx";
import {
  agentWritesInTurn,
  diffHunks,
  isPossibleWriteTool,
  writePhaseOf,
  type AgentWrite,
  type AgentWritePhase,
  type EditorHunk,
} from "./editor-collab.ts";

/** 回合结束时给编辑器的一次同步请求（token 单调递增，同一份内容只会被同步一次） */
export interface EditorSyncRequest {
  token: number;
  text: string;
}

export interface EditorCollabState {
  /** 本轮 agent 的写入集（回合之外恒为空） */
  writes: readonly AgentWrite[];
  /**
   * 本轮出现过「可能写文件」的工具（shell / 终端执行 / MCP）。它们改哪个文件我们看不见，
   * 所以打开的文件都按「可能被写」处理：只读 + 暂停自动保存。
   */
  mayWrite: boolean;
  /** 本轮 agent 的改动块（按文件绝对路径） */
  hunks: ReadonlyMap<string, readonly EditorHunk[]>;
  /** 回合结束时要交给编辑器同步的盘上内容（按文件绝对路径）；没有就空表 */
  sync: ReadonlyMap<string, EditorSyncRequest>;
  /** 撤销成功的块从清单里去掉（编辑器撤完回调） */
  dropHunks: (path: string, ids: readonly string[]) => void;
  /** 某个文件在本轮的写入阶段 */
  writePhase: (path: string) => AgentWritePhase | null;
}

interface Snapshot {
  text: string;
  dirty: boolean;
}

export function useEditorCollab(input: {
  /** 会话身份：换了会话，上一轮的块与快照一律作废（同一个绝对路径属于同一条会话的上下文） */
  sessionId: string | null;
  phase: ChatSession["phase"];
  transcript: readonly TranscriptItem[];
  cwd: string | null;
  /** 编辑器把手表（FilesPanel 的 editorsRef）：快照从活着的编辑器上抓 */
  editors: { readonly current: ReadonlyMap<string, TexEditorHandle> };
  /** 登记表的版本号：编辑器挂载 / 卸载时加一，用来触发「新挂上来的文件补一次快照」 */
  editorsVersion: number;
  /** 按路径拼 fs:read 的请求（面板的根与白名单口径）；不可编辑的标签返回 null */
  requestFor: (path: string) => FileListRequest | null;
}): EditorCollabState {
  const [hunks, setHunks] = useState<ReadonlyMap<string, readonly EditorHunk[]>>(new Map());
  const [sync, setSync] = useState<ReadonlyMap<string, EditorSyncRequest>>(new Map());

  const snapshotsRef = useRef(new Map<string, Snapshot>());
  const runningRef = useRef(false);
  const sessionRef = useRef(input.sessionId);
  /**
   * 本轮的起点 = 开轮那一刻 transcript 的长度。**不能用「最后一条 user 消息」**：
   * 真回显比 phase 事件晚到几十毫秒，按 user 消息取会把上一轮的工具调用算进这一轮，
   * 开轮那一帧整片误只读（P2）。
   *
   * 在**渲染期**更新（不是 effect）：开轮这一帧就要用它算写入集，等 effect 会晚一帧，
   * 正好是父会话量到的那 90ms 误只读。值只由 phase 与 transcript 长度推导，无副作用。
   */
  const boundaryRef = useRef<{ active: boolean; at: number }>({ active: false, at: 0 });
  if (input.phase === "turn" && !boundaryRef.current.active) {
    boundaryRef.current = { active: true, at: input.transcript.length };
  } else if (input.phase !== "turn" && boundaryRef.current.active) {
    boundaryRef.current = { active: false, at: 0 };
  }
  const boundary = boundaryRef.current.active ? boundaryRef.current.at : null;
  const syncTokenRef = useRef(0);
  const requestForRef = useRef(input.requestFor);
  requestForRef.current = input.requestFor;

  const writes = useMemo(
    () =>
      input.phase === "turn"
        ? agentWritesInTurn(input.transcript, input.cwd, boundary ?? undefined)
        : [],
    [input.phase, input.transcript, input.cwd, boundary],
  );

  /** 本轮是否有「看不见写了哪个文件」的工具（shell / 终端执行 / MCP） */
  const mayWrite = useMemo(() => {
    if (input.phase !== "turn") return false;
    const from = boundary ?? 0;
    for (let index = Math.max(0, Math.min(from, input.transcript.length)); index < input.transcript.length; index += 1) {
      const item = input.transcript[index];
      if (item === undefined || item.role !== "assistant") continue;
      for (const block of item.content) {
        if (block.type !== "toolCall") continue;
        if (isPossibleWriteTool(block.toolName)) return true;
      }
    }
    return false;
  }, [input.phase, input.transcript, boundary]);

  /** 给每个挂着的编辑器补一份快照（本轮还没抓过这个文件才记） */
  const snapshotMounted = useCallback((): void => {
    for (const [path, handle] of input.editors.current) {
      if (snapshotsRef.current.has(path)) continue;
      const text = handle.text();
      if (text === null) continue;
      snapshotsRef.current.set(path, { text, dirty: handle.isDirty() });
    }
  }, [input.editors]);

  /** 读一次盘上的文本；不可编辑的标签 / 读失败 / 读成二进制或截断都算没有 */
  const readDisk = useCallback(async (path: string): Promise<string | null> => {
    const request = requestForRef.current(path);
    if (request === null) return null;
    try {
      const preview = await api.files.read(request);
      return preview.kind === "text" && !preview.truncated ? preview.text : null;
    } catch {
      // 读不出来（被删 / 权限）不改任何状态：没有内容就没有可同步的东西
      return null;
    }
  }, []);

  const finishTurn = useCallback(async (): Promise<void> => {
    const snapshots = snapshotsRef.current;
    // 挂着的编辑器也要同步（哪怕这一轮开始时还没抓过快照：它打开的就是当前盘上那份）
    const mounted = [...input.editors.current.keys()];
    const paths = [...new Set([...snapshots.keys(), ...mounted])];
    const disk = new Map<string, string>();
    await Promise.all(
      paths.map(async (path) => {
        const text = await readDisk(path);
        if (text !== null) disk.set(path, text);
      }),
    );

    const next = new Map<string, readonly EditorHunk[]>();
    for (const path of snapshots.keys()) {
      const snapshot = snapshots.get(path);
      const text = disk.get(path);
      if (snapshot === undefined || text === undefined) continue;
      // 本轮开始时是脏的：diff 里混着用户自己的字，不做块级撤销（冲突条在管）
      if (snapshot.dirty) continue;
      if (snapshot.text === text) continue;
      const blocks = diffHunks(snapshot.text, text);
      if (blocks.length > 0) next.set(path, blocks);
    }
    setHunks(next);

    const requests = new Map<string, EditorSyncRequest>();
    for (const path of mounted) {
      const text = disk.get(path);
      if (text === undefined) continue;
      syncTokenRef.current += 1;
      requests.set(path, { token: syncTokenRef.current, text });
    }
    setSync(requests);
  }, [input.editors, readDisk]);

  // 换了会话：上一轮的快照与改动块不属于这一条，整个清掉
  useEffect(() => {
    if (sessionRef.current === input.sessionId) return;
    sessionRef.current = input.sessionId;
    snapshotsRef.current = new Map();
    runningRef.current = input.phase === "turn";
    boundaryRef.current = { active: input.phase === "turn", at: input.transcript.length };
    setHunks(new Map());
    setSync(new Map());
  }, [input.sessionId, input.phase]);

  // 回合边界：开轮抓快照并清上一轮的块；落定读盘、算块、请编辑器同步
  useEffect(() => {
    const running = input.phase === "turn";
    if (running && !runningRef.current) {
      runningRef.current = true;
      snapshotsRef.current = new Map();
      setHunks(new Map());
      setSync(new Map());
      snapshotMounted();
      return;
    }
    if (!running && runningRef.current) {
      runningRef.current = false;
      void finishTurn();
    }
    // snapshotMounted 依赖登记表本身（不随版本号变），finishTurn 同理
  }, [input.phase, snapshotMounted, finishTurn]);

  // 回合中途有新编辑器挂上来（切标签 / 布局变化）：这一版就是用户眼前的那一版
  useEffect(() => {
    if (input.phase !== "turn") return;
    snapshotMounted();
  }, [input.phase, input.editorsVersion, snapshotMounted]);

  const dropHunks = useCallback((path: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    setHunks((current) => {
      const list = current.get(path);
      if (list === undefined) return current;
      const keep = list.filter((hunk) => !ids.includes(hunk.id));
      if (keep.length === list.length) return current;
      const next = new Map(current);
      if (keep.length === 0) next.delete(path);
      else next.set(path, keep);
      return next;
    });
  }, []);

  const writePhase = useCallback(
    (path: string): AgentWritePhase | null => writePhaseOf(writes, path),
    [writes],
  );

  return { writes, mayWrite, hunks, sync, dropHunks, writePhase };
}
