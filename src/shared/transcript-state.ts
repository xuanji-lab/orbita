/**
 * 转录归约器 —— 从 @earendil-works/pi-coding-agent 0.84.3 的 `./client` 子入口收编。
 *
 * 收编原因：pi 1.1.0 删掉了未发布的实验 server / client 栈，`pi-coding-agent/client`
 * 子入口随之消失（coding-agent CHANGELOG 1.1.0「Removed the unreleased experimental
 * server, client, and plugin stack … and its source-only `./client` … exports」）。
 * renderer 的会话槽一直用这四个函数把快照 + 增量帧归约成转录（session-states.ts 的
 * 「transcript 归约沿用 pi 自带的归约器，我们不写第二份」）；类型已在
 * ./transcript.ts 收编，归约器跟着收编，行为逐行不变。
 *
 * 来源与版权（MIT License）：
 * Copyright (c) 2025 Mario Zechner
 * 源自 https://github.com/earendil-works/pi 的 packages/coding-agent/src/client/transcript.ts
 * （tag v0.84.3，与安装版 dist/client/transcript.js 对照一致）。只改了 import 路径与缩进。
 */
import type { JsonValue, SessionSnapshot, TranscriptItem, TranscriptProgress } from "./transcript.ts";

export interface TranscriptState {
  readonly snapshot: SessionSnapshot;
  readonly progressItems: ReadonlyMap<string, TranscriptItem>;
  readonly progressOrder: readonly string[];
  readonly toolCallBuffers: ReadonlyMap<string, string>;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJsonValue);
}

function parsePartialToolInput(value: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isJsonValue(parsed)) return parsed;
  } catch {
    // 流式中工具参数还不完整：保留原始前缀，等它拼成合法 JSON
  }
  return value;
}

export function createTranscriptState(snapshot: SessionSnapshot): TranscriptState {
  return {
    snapshot: structuredClone(snapshot),
    progressItems: new Map(),
    progressOrder: [],
    toolCallBuffers: new Map(),
  };
}

export function applyTranscriptSnapshot(state: TranscriptState, snapshot: SessionSnapshot): TranscriptState {
  if (state.snapshot.id === snapshot.id && snapshot.revision < state.snapshot.revision) return state;
  return createTranscriptState(snapshot);
}

export function applyTranscriptProgress(state: TranscriptState, progress: TranscriptProgress): TranscriptState {
  if (progress.type === "item_started" || progress.type === "item_updated") {
    return setProgressItem(state, progress.item);
  }
  if (progress.type === "item_finished") {
    const toolCallBuffers = new Map(state.toolCallBuffers);
    for (const key of toolCallBuffers.keys()) {
      if (key.startsWith(`${progress.item.id}:`)) toolCallBuffers.delete(key);
    }
    return setProgressItem({ ...state, toolCallBuffers }, progress.item);
  }

  const item =
    state.progressItems.get(progress.messageId) ??
    state.snapshot.transcript.find(({ id }) => id === progress.messageId);
  if (!item || item.role !== "assistant") return state;
  let toolCallBuffers = state.toolCallBuffers;
  const content = item.content.map((part, index) => {
    if (index !== progress.contentIndex) return structuredClone(part);
    if (progress.kind === "text" && part.type === "text") return { ...part, text: part.text + progress.delta };
    if (progress.kind === "thinking" && part.type === "thinking") {
      return { ...part, thinking: part.thinking + progress.delta };
    }
    if (progress.kind === "toolCall" && part.type === "toolCall") {
      const key = `${progress.messageId}:${progress.contentIndex}`;
      const existing = state.toolCallBuffers.get(key) ?? (typeof part.input === "string" ? part.input : "");
      const buffer = existing + progress.delta;
      toolCallBuffers = new Map(state.toolCallBuffers).set(key, buffer);
      return { ...part, input: parsePartialToolInput(buffer) };
    }
    return structuredClone(part);
  });
  return setProgressItem({ ...state, toolCallBuffers }, { ...item, content });
}

export function selectTranscript(state: TranscriptState): readonly TranscriptItem[] {
  const transcript = state.snapshot.transcript.map((item) => state.progressItems.get(item.id) ?? item);
  const ids = new Set(transcript.map((item) => item.id));
  for (const id of state.progressOrder) {
    if (ids.has(id)) continue;
    const item = state.progressItems.get(id);
    if (item) {
      transcript.push(item);
      ids.add(id);
    }
  }
  for (const item of state.snapshot.queuedSteer) {
    if (ids.has(item.id)) continue;
    transcript.push(item);
    ids.add(item.id);
  }
  return transcript;
}

function setProgressItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
  const progressItems = new Map(state.progressItems);
  const progressOrder = progressItems.has(item.id) ? state.progressOrder : [...state.progressOrder, item.id];
  progressItems.set(item.id, structuredClone(item));
  return { ...state, progressItems, progressOrder };
}
