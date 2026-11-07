/**
 * 插图落哪儿（纯函数）：Obsidian 的 `attachmentFolderPath` 设置语义 + 本仓的默认。
 *
 * `.obsidian/app.json` 的 `attachmentFolderPath`：
 * - 缺省 / 空 / `/`：库根目录（Obsidian 自己的默认；本仓无 `.obsidian` 时改用 `attachments/`，见 `attachmentDir`）；
 * - `./子目录`：相对**当前文档所在目录**；`./` 或 `.`：与文档同目录；
 * - 其它（`附件`、`assets/img`）：相对库根。
 * 结果一律是相对库根的目录（`""` = 库根），越出库根的写法（`../x`）退回库根下的 `attachments`。
 */
import { normalizeRel } from "./resolve.ts";

export const DEFAULT_ATTACHMENT_DIR = "attachments";

export interface AttachmentContext {
  /** 工作区里有 `.obsidian` 目录（是 Obsidian 库） */
  vault: boolean;
  /** `.obsidian/app.json` 里的 attachmentFolderPath；没有设置 = undefined */
  setting: string | undefined;
  /** 文档所在目录（相对库根，`/` 分隔，根目录 = ""） */
  docDir: string;
}

export function attachmentDir(ctx: AttachmentContext): string {
  const setting = ctx.setting?.trim();
  if (setting === undefined || setting === "") return ctx.vault ? "" : DEFAULT_ATTACHMENT_DIR;
  if (setting === "/") return "";
  const relative = setting === "." || setting === "./" || setting.startsWith("./");
  const joined = relative ? `${ctx.docDir}/${setting}` : setting;
  return normalizeRel(joined) ?? DEFAULT_ATTACHMENT_DIR;
}

/** 文件名清洗：去掉路径与非法字符，保留扩展名；空了给个兜底名 */
export function safeAttachmentName(name: string, fallbackExt = "png"): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  const cleaned = base.replace(/^\.+/, "");
  if (cleaned === "" || !/\.[A-Za-z0-9]{1,6}$/.test(cleaned)) return `${cleaned === "" ? "image" : cleaned}.${fallbackExt}`;
  return cleaned;
}

/** 重名加序号：`a.png` → `a 1.png`、`a 2.png`…（taken 判断某名是否已占用） */
export function uniqueAttachmentName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  for (let n = 1; n < 10000; n += 1) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error("同名附件太多，换个名字再插");
}

/** 要插进文档的那段 markdown：库里写 `![[名]]`，其它写相对文档的标准图片语法 */
export function imageMarkdown(opts: { vault: boolean; name: string; relFromDoc: string }): string {
  if (opts.vault) return `![[${opts.name}]]`;
  const path = opts.relFromDoc;
  return `![](${/[\s()]/.test(path) ? `<${path}>` : path})`;
}
