/**
 * 输入框附图：分拣（能不能进）与读取（File → base64）。
 *
 * 准入规则本身在 `shared/prompt-images.ts`（agent 进程还要再拦一道，两边同一份）；
 * 这里只管输入框这一侧的事：按顺序收、满了就停、每一张被拒都要说出名字和原因——
 * 一次拖进来五张、悄悄少了两张，用户不会发现，模型却会对着缺图的问题瞎答。
 */
import {
  PROMPT_IMAGE_MAX_BYTES,
  PROMPT_IMAGE_MAX_COUNT,
  checkPromptImage,
  type PromptImage,
  type PromptImageRejection,
} from "../../../shared/prompt-images.ts";
import type { Messages } from "../messages-en.ts";

/** 输入框里的一张图。id 只给 React key 与「移除」用，不上 IPC */
export interface ComposerImage {
  id: string;
  /** 文件名（粘贴来的截图多半叫 image.png）；撤回的排队项拿不回名字，是空串 */
  name: string;
  image: PromptImage;
}

export interface ImageRejection {
  name: string;
  reason: PromptImageRejection | "too-many";
}

/**
 * 分拣一批文件。**按顺序收**：前面的先占名额，名额满了之后的每一张都记 too-many
 * （而不是只报一句「太多了」——用户得知道是哪几张没进来）。
 */
export function admitImages<F extends { name: string; type: string; size: number }>(
  files: readonly F[],
  existing: number,
): { accepted: F[]; rejected: ImageRejection[] } {
  const accepted: F[] = [];
  const rejected: ImageRejection[] = [];
  for (const file of files) {
    const reason = checkPromptImage(file);
    if (reason !== null) rejected.push({ name: file.name, reason });
    else if (existing + accepted.length >= PROMPT_IMAGE_MAX_COUNT) rejected.push({ name: file.name, reason: "too-many" });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/**
 * 一批拒绝 → 一句提示。too-many 合并成一句（它的原因跟哪张图无关），
 * 其余逐张列名字。
 */
export function rejectionText(rejected: readonly ImageRejection[], t: Messages): string | null {
  if (rejected.length === 0) return null;
  const lines: string[] = [];
  for (const item of rejected) {
    if (item.reason === "unsupported") lines.push(t.composer.imageUnsupported(item.name));
    else if (item.reason === "too-large") {
      lines.push(t.composer.imageTooLarge(item.name, PROMPT_IMAGE_MAX_BYTES / 1024 / 1024));
    }
  }
  if (rejected.some((item) => item.reason === "too-many")) lines.push(t.composer.tooManyImages(PROMPT_IMAGE_MAX_COUNT));
  return lines.join(" ");
}

/** 剪贴板 / 拖放的 DataTransfer 里挑出文件（文字粘贴不在这里，照常进输入框） */
export function filesOf(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  return Array.from(transfer.files);
}

/** File → pi 的 ImageContent。缩放不在这里做（agent 进程按 pi 的口径缩） */
export function readAsPromptImage(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(file.name));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) {
        reject(new Error(file.name));
        return;
      }
      resolve({ type: "image", data: url.slice(comma + 1), mimeType: file.type });
    };
    reader.readAsDataURL(file);
  });
}

/** 渲染用的 data URL（缩略图与转录里的图共用） */
export function imageSrc(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
