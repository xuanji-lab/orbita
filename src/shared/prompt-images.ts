/**
 * 用户消息附带的图片——契约与准入规则。
 *
 * 形状就是 pi 的 `ImageContent`（`{ type: "image", data: base64, mimeType }`）：
 * pi 的 `prompt(text, { images })` 与协议的 user 内容块收的都是它，我们不另造一层。
 *
 * 准入规则放在 shared，因为有两个消费者：renderer 在图片进输入框之前就拦
 * （用户当场看到哪张不行、为什么），agent 进程在交给 pi 之前再拦一道
 * （renderer 不是唯一的信任边界——载荷穿过两跳 IPC）。两边各写一份迟早漂移。
 */
import type { ImageContent } from "@earendil-works/pi-protocol";

export type PromptImage = ImageContent;

/**
 * 主进程→agent 进程的图：原图数据 + 原图在磁盘上的引用。
 *
 * **原图给人看、缩放图发模型**：agent 进程把 data 缩到 pi 的上限再发给模型、写进转录，
 * `original` 原样挂在转录的图块上——看大图时按它读回原图。转录不存原图：
 * 一张 5K 截图几 MB，写进 JSONL 的话打开会话就要整份读进来。
 *
 * 引用由主进程铸（renderer 的载荷是裸 `PromptImage`，它指不了路径）。
 * 缺席 = 没有原图可看（落盘失败、或这条引用落地之前发的图）。
 */
export interface SentImage extends PromptImage {
  original?: string;
}

/**
 * 原图引用：`<会话 id>/<uuid>.<扩展名>`。**带会话 id** 是为了读的一侧不必知道
 * 「这张图在哪条会话里」——分支出来的会话沿用源会话的引用，不拷原图；源会话删了
 * 就读不到，退回转录里的缩放图。
 * 格式死定是安全边界：它会被拼进路径，过不了这条正则的一律不读。
 */
const ORIGINAL_REF =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export function isOriginalRef(value: unknown): value is string {
  return typeof value === "string" && ORIGINAL_REF.test(value);
}

/** 转录图块上的原图引用。这是我们自挂的字段（不在 pi 的 schema 里），按未知形状读 */
export function originalRefOf(block: object): string | null {
  const value = (block as { original?: unknown }).original;
  return isOriginalRef(value) ? value : null;
}

/** 原图文件的扩展名。只有准入的四种，其余返回 null */
export function originalExtension(mimeType: string): string | null {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return null;
}

/** 扩展名→MIME，读原图时用（originalExtension 的逆） */
export function mimeOfExtension(extension: string): string | null {
  return (
    { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>
  )[extension] ?? null;
}

/**
 * 能直接发给模型的格式。**与 pi 的 `processImage` 认的那四种一致**：各家 API
 * 都只收这几种，别的（HEIC、TIFF、SVG）要先转码——转码不在这一刀的范围里，
 * 与其发出去被上游拒掉整条对话，不如在门口说清楚。
 */
export const PROMPT_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * 原图体积上限（压缩前）。进 agent 进程后会按 pi 的口径缩到 2000px / 4.5MB 以内
 * （`resizeImage`，与 read 工具读图同一套），所以这不是模型的上限，
 * 是「一张图值不值得 base64 过两跳 IPC」的上限——30MB 的原图多半是误拖进来的。
 */
export const PROMPT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/** 一条消息最多几张。多了既贵又慢，模型也看不过来。 */
export const PROMPT_IMAGE_MAX_COUNT = 10;

/**
 * 一条消息内所有图片的**原始字节总和**上限。原图进 agent 进程后各自会被缩到
 * 2000px / 4.5MB，缩放前的总量是一个保守的代理指标；20MB 给服务商约 32MB 的
 * 单请求上限留余量（历史轮次还会占预算，见 agent/image-byte-budget.ts）。
 * 超线时门口拒收并建议改用文件夹附加（只传路径，模型按需逐张 read）。
 */
export const PROMPT_IMAGES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

export type PromptImageRejection = "unsupported" | "too-large";

/** 一张图能不能进输入框。null = 可以 */
export function checkPromptImage(file: { type: string; size: number }): PromptImageRejection | null {
  if (!PROMPT_IMAGE_MIME_TYPES.includes(file.type)) return "unsupported";
  if (file.size > PROMPT_IMAGE_MAX_BYTES) return "too-large";
  return null;
}
