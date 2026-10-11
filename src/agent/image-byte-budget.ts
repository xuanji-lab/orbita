/**
 * 图片字节预算 —— 超过阈值时把最早的图片替换成文字占位，只改发给模型的请求。
 *
 * 为什么按字节不按 token：Anthropic 对单条请求有 32MB 上限（`request_too_large`），
 * 而图片每张只计一千多 token——token 口径的自动压缩永远追不上字节口径的爆炸
 * （2026-10 真实会话：54 张图 ≈31MB base64，token 只有 ~42 万，每轮 413/502）。
 *
 * 只动 wire（pi 扩展的 `context` 事件 = transformContext）：orbita 转录与 pi 本子
 * 里的消息原样保留，界面照常显示图片。
 *
 * **前缀稳定是硬要求**（prompt cache 按前缀命中）：触发替换用「水位」锚定——
 * 水位是（消息时间戳，下标）二元组，语义是「被它覆盖的消息里的图片一律占位」。
 * 推进以消息为粒度（整条消息的图全换或全不换），水位落在被换的最后一条消息上；
 * 此后各轮用同一水位重放，得到逐字节相同的前缀，直到再次越过触发线才前进一档。
 * 纯无状态地每轮重算「换到 16MB 以下」会让切点每轮微移，cache 每轮失效——不这么干。
 *
 * 水位持久化在 pi 本子的 custom entry（不进 LLM 上下文）；用户附件原图的
 * `original` 引用（`sessions/<会话id>.attachments/` 下的相对引用）pi 本子里没有，
 * 每轮随图一起记一份 hash→引用的 entry，占位时才能给出可 read 回来的绝对路径。
 * 回退越过水位时，水位随废枝一起失效（下一轮读到的是更早的水位或没有水位），
 * 图片回到请求里，需要时会再次触发——这是接受的语义。
 *
 * 纯模块：不 import electron、不 import 进程相关的东西，可被 `node --test` 直接加载。
 */
import { createHash } from "node:crypto";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

/** context 事件给到的消息形状（AgentMessage 的结构化子集，经 pi 的 structuredClone 到手） */
export type ContextMessage = ContextEvent["messages"][number];

/** 触发线与目标线。触发 = 估算请求 > 24MB（Anthropic 32MB 上限留 8MB 给 system + tools +
 * JSON 结构）；换到 16MB 以下（给当前轮的新图与回复留余量）。 */
export const IMAGE_BUDGET_TRIGGER_BYTES = 24 * 1024 * 1024;
export const IMAGE_BUDGET_TARGET_BYTES = 16 * 1024 * 1024;

/** 水位 entry（custom，不进上下文）：data = { cut, replaced, bytesAfter } */
export const IMAGE_BUDGET_ENTRY = "orbita-image-budget";
/** 附件引用 entry（custom，不进上下文）：data = [hash, originalRef][]，每轮带图才写 */
export const IMAGE_REFS_ENTRY = "orbita-image-refs";

/** 水位：消息时间戳（ms）+ 触发轮被替换的最后一条消息在数组里的下标。
 * 时间戳为主锚；下标消除同毫秒歧义——同 ms 的两条消息若只替换了前一条，
 * 重放时必须靠下标才能得出与触发轮完全相同的替换集（前缀逐字节稳定是硬要求）。
 * 前缀消息的下标跨轮恒定（新消息只追加），下标锚因此是稳定的。 */
export interface ImageBudgetMark {
  cut: number;
  cutIndex: number;
  replaced: number;
  bytesAfter: number;
}

/** 开轮时从 pi 本子（当前叶子路径）读出的预算状态 */
export interface ImageBudgetBook {
  /** 现行水位；null = 还没触发过 */
  mark: ImageBudgetMark | null;
  /** 图片内容 hash（sha256，base64 data）→ 原图引用（`<会话id>/<uuid>.<ext>`） */
  refs: Map<string, string>;
}

/** 消息 (下标, 时间戳) 是否已被现行水位覆盖 */
function coveredByWatermark(index: number, ts: number | null, mark: ImageBudgetMark | null): boolean {
  if (mark === null || ts === null) return false;
  return ts < mark.cut || (ts === mark.cut && index <= mark.cutIndex);
}

/**
 * 读本子（用 `getBranch()`：文件序会把废枝数进来，回退后必然错位）。
 * 水位取**最后一条**预算 entry；引用逐条合并（同 hash 后写覆盖先写——引用稳定，覆盖无害）。
 */
export function readImageBudgetBook(branch: readonly SessionEntry[]): ImageBudgetBook {
  const book: ImageBudgetBook = { mark: null, refs: new Map() };
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === IMAGE_BUDGET_ENTRY) {
      const data = entry.data as { cut?: unknown; cutIndex?: unknown } | undefined;
      if (typeof data?.cut === "number" && typeof data?.cutIndex === "number") {
        book.mark = { cut: data.cut, cutIndex: data.cutIndex, replaced: 0, bytesAfter: 0 };
      }
    } else if (entry.customType === IMAGE_REFS_ENTRY) {
      const pairs = entry.data;
      if (!Array.isArray(pairs)) continue;
      for (const pair of pairs) {
        if (
          Array.isArray(pair) &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "string" &&
          pair[0] !== "" &&
          pair[1] !== ""
        ) {
          book.refs.set(pair[0], pair[1]);
        }
      }
    }
  }
  return book;
}

/** 一张图的 sha256（hex）。占位路径与水位重放都靠它对上同一张图 */
export function hashImage(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 从图片头解析像素尺寸。只做头解析不解码：PNG（IHDR）/ GIF（逻辑屏幕）/ JPEG
 * （SOF marker 扫描）；WEBP 的三种 chunk 布局太杂，解析不出就省略尺寸段——
 * 占位文本不因缺尺寸而失效。解析失败返回 null。
 */
export function imageSizeOf(data: string, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    // base64 前缀解码对应原字节前缀；64 字符 → 48 字节，盖过 24 字节的 IHDR
    const head = Buffer.from(data.slice(0, 64), "base64");
    if (head.length >= 24 && head.readUInt32BE(12) === 0x49484452) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    return null;
  }
  if (mimeType === "image/gif") {
    const head = Buffer.from(data.slice(0, 32), "base64");
    if (head.length >= 10 && head.subarray(0, 3).toString("latin1") === "GIF") {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    return null;
  }
  if (mimeType === "image/jpeg") {
    // SOF 藏在任意深度的 marker 链里（EXIF 可达几十 KB），只能走全量
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === undefined) return null;
      // 无长度的 marker（RST、SOI/EOI 一族）
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0..SOF15 除 DHT(C4)、JPG(C8)、DAC(CC)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (offset + 9 > bytes.length) return null;
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** 估算消息列表的 wire 字节数。JSON 序列化的 UTF-8 长度——与 provider 请求体的
 * 距离只在 system prompt / tools schema（几十 KB 量级），24MB 触发线对 32MB 上限
 * 留了 8MB，余量足够。 */
export function estimateMessagesBytes(messages: readonly ContextMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

/** 替换计划：messages 已是替换后的副本（原数组不动）；advancedCut 为 null 表示不推进 */
export interface ImageBudgetPlan {
  messages: ContextMessage[];
  /** 本轮推进到的新水位；null = 沿用旧水位（或根本没触发） */
  advancedCut: ImageBudgetMark | null;
  /** 被占位的图片总数（应用旧水位 + 本轮推进） */
  replaced: number;
  bytesBefore: number;
  bytesAfter: number;
}

interface ImageLike {
  type: "image";
  data: string;
  mimeType: string;
}

function isImage(block: unknown): block is ImageLike {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function messageTimestamp(message: ContextMessage): number | null {
  const ts = (message as { timestamp?: unknown }).timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

/** 工具调用索引：toolCallId → { name, args }，占位的来源描述从 assistant 消息里取 */
function toolCallIndex(messages: readonly ContextMessage[]): Map<string, { name: string; args: Record<string, unknown> }> {
  const index = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { id?: unknown }).id === "string"
      ) {
        const call = block as { id: string; name?: unknown; arguments?: unknown };
        index.set(call.id, {
          name: typeof call.name === "string" ? call.name : "",
          args:
            typeof call.arguments === "object" && call.arguments !== null
              ? (call.arguments as Record<string, unknown>)
              : {},
        });
      }
    }
  }
  return index;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** browser_screenshot 存盘时结果正文里带的绝对路径（主进程拼的句子，路径后跟句号+空白） */
const SAVED_SHOT_PATH = /Saved the full-resolution image to (.+?)\.(?:\s|$)/;

/** 一张图的来源描述（占位正文里「这是什么图」那一段） */
function imageSource(
  message: ContextMessage,
  imageOrdinal: number,
  calls: Map<string, { name: string; args: Record<string, unknown> }>,
): { source: string; path: string | null } {
  const record = message as { role?: unknown; toolCallId?: unknown; content?: unknown };
  if (record.role !== "toolResult") {
    // user 消息里的图只有一种来源：用户附件。路径由 refs（hash→引用）在调用侧补
    return { source: "用户附件", path: null };
  }
  const call = typeof record.toolCallId === "string" ? calls.get(record.toolCallId) : undefined;
  if (call === undefined) return { source: "工具结果里的图片", path: null };
  if (call.name === "read") {
    return { source: "read 读取的图片", path: asString(call.args["path"]) };
  }
  if (call.name === "show_image") {
    const paths = Array.isArray(call.args["paths"])
      ? (call.args["paths"] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    return { source: "show_image 展示的图片", path: asString(paths[imageOrdinal]) };
  }
  if (call.name === "browser_screenshot") {
    const content = record.content;
    let path: string | null = null;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isTextBlock(block)) continue;
        const hit = SAVED_SHOT_PATH.exec(block.text);
        if (hit?.[1] !== undefined) {
          path = hit[1];
          break;
        }
      }
    }
    return { source: "browser_screenshot 的截图", path };
  }
  return { source: `工具 ${call.name} 返回的图片`, path: null };
}

/** 占位文本。确定性：同一条消息里的同一张图，任何一轮算出的文本逐字节相同 */
function placeholderOf(source: { source: string; path: string | null }, image: ImageLike, absolutePath: string | null): string {
  const size = imageSizeOf(image.data, image.mimeType);
  const sizeText = size === null ? "" : `，${size.width}×${size.height}`;
  const path = absolutePath ?? source.path;
  return path === null
    ? `[图片已省略（控制请求大小）：${source.source}${sizeText}；原图不可取回]`
    : `[图片已省略（控制请求大小）：${source.source}${sizeText}，原图 ${path}；需要时用 read 工具重新查看]`;
}

/** utf8 字节数（JSON 里中文按 3 字节计，别用 length 数字符） */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 规划一次替换。
 *
 * @param messages context 事件给到的消息（pi 已 structuredClone，本函数再浅拷贝需要改的消息，
 *   不动入参数组）
 * @param watermark 现行水位（开轮从本子读）；null = 从未触发
 * @param refs 图片 hash → 原图**绝对路径**（本子 entry + 本轮 submit 合并后由调用侧拼好）
 * @param protectedFloor 保护起点下标：最后一条用户消息（及其之后）的图片永不占位。
 *   调用侧每轮取「见过的最小值」——steer 注入会把「最后一条用户消息」推后，
 *   不能让刚发过的本轮附图因此变成可替换。
 */
export function planImageBudget(
  messages: readonly ContextMessage[],
  watermark: ImageBudgetMark | null,
  refs: ReadonlyMap<string, string>,
  protectedFloor: number,
): ImageBudgetPlan {
  const bytesBefore = estimateMessagesBytes(messages);
  // 保护段：floor 之前才可替换；没有用户消息（floor 为 +∞ 的初值场景）时全部可替换
  const floor = Math.min(protectedFloor, messages.length);
  const calls = toolCallIndex(messages);
  const working: ContextMessage[] = [...messages];
  let replaced = 0;
  let saved = 0;

  // JSON 里 image 块 ≈ data.length + 60 字节，text 块 ≈ 内容 + 28 字节
  const savedByReplacing = (image: ImageLike, text: string): number =>
    image.data.length + 60 - (utf8Bytes(text) + 28);

  const replaceMessage = (index: number): boolean => {
    const message = working[index];
    if (message === undefined) return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    let imageOrdinal = 0;
    let touched = false;
    const nextContent: unknown[] = [];
    for (const block of content) {
      if (!isImage(block)) {
        nextContent.push(block);
        continue;
      }
      const source = imageSource(message, imageOrdinal, calls);
      const path = refs.get(hashImage(block.data)) ?? null;
      const text = placeholderOf(source, block, path);
      saved += savedByReplacing(block, text);
      replaced += 1;
      touched = true;
      nextContent.push({ type: "text", text });
      imageOrdinal += 1;
    }
    if (!touched) return false;
    working[index] = { ...(message as object), content: nextContent } as ContextMessage;
    return true;
  };

  // 1) 重放现行水位：与触发轮完全相同的替换集（时间戳 + 下标双锚）
  if (watermark !== null) {
    for (let index = 0; index < floor; index += 1) {
      const message = messages[index];
      if (message === undefined) continue;
      if (coveredByWatermark(index, messageTimestamp(message), watermark)) {
        replaceMessage(index);
      }
    }
  }

  let bytesAfter = bytesBefore - saved;
  let advancedCut: ImageBudgetMark | null = null;

  // 2) 越线才推进：从最早的可替换消息整条换起，直到落回目标线以下
  if (bytesAfter > IMAGE_BUDGET_TRIGGER_BYTES) {
    for (let index = 0; index < floor && bytesAfter > IMAGE_BUDGET_TARGET_BYTES; index += 1) {
      const message = messages[index];
      if (message === undefined) continue;
      const ts = messageTimestamp(message);
      if (ts === null || coveredByWatermark(index, ts, watermark)) continue;
      if (!replaceMessage(index)) continue;
      advancedCut = { cut: ts, cutIndex: index, replaced: 0, bytesAfter: 0 };
      bytesAfter = bytesBefore - saved;
    }
  }

  return { messages: working, advancedCut, replaced, bytesBefore, bytesAfter };
}
