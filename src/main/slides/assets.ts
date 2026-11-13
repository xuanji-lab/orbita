/**
 * 演示文稿的图片资源：复制进 `<名字>.assets/`，JSON 里只存相对路径。
 *
 * **纯 node 模块**（不 import electron）：主进程（用户拖入 / 粘贴 / 选文件）与 agent 进程
 * （slides_insert_image）共用——一处真源，两个入口。
 * - 魔数认 png / jpeg / gif / webp，其余拒绝（扩展名会说谎）；单张 ≤ 30 MB；
 * - 文件名取安全字符；同名**同内容**复用，同名不同内容加内容摘要后缀（不覆盖别人的图）；
 * - 目标永远在 deckDir 下的 assets 目录：名字里的路径分隔符与 `..` 一律洗掉。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { readImageInfo, type ImageInfo } from "../../shared/image-size.ts";
import { assetsDirName } from "../../shared/slides.ts";
import { writeBytesAtomic } from "../atomic-write.ts";

export const ASSET_MAX_BYTES = 30 * 1024 * 1024;

const EXT_OF: Readonly<Record<ImageInfo["format"], string>> = { png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp" };

export interface SavedAsset {
  /** 相对 .slides.json 所在目录：`<名字>.assets/x.png` */
  src: string;
  absolute: string;
  info: ImageInfo;
}

/** 文件名洗成安全的：去目录、保留字母数字 CJK 与 ._-，其余变 `-`，限长 */
export function safeAssetName(raw: string, format: ImageInfo["format"]): string {
  const base = basename(raw.replace(/\\/g, "/"));
  const stem = base.slice(0, base.length - extname(base).length) || "image";
  const cleaned = stem
    .replace(/[^\w\u4e00-\u9fff.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  return `${cleaned === "" ? "image" : cleaned}${EXT_OF[format]}`;
}

export async function saveAssetBytes(deckPath: string, fileName: string, bytes: Uint8Array): Promise<SavedAsset> {
  if (bytes.length === 0) throw new Error("图片是空的");
  if (bytes.length > ASSET_MAX_BYTES) throw new Error(`图片太大（${Math.round(bytes.length / 1024 / 1024)} MB，上限 30 MB）`);
  const info = readImageInfo(bytes);
  if (info === null) throw new Error("不是支持的图片（只认 PNG / JPEG / GIF / WebP）");
  const deckDir = dirname(deckPath);
  const dirName = assetsDirName(deckPath);
  const name = safeAssetName(fileName, info.format);
  const digest = createHash("sha1").update(bytes).digest("hex");
  await mkdir(join(deckDir, dirName), { recursive: true });
  const candidates = [name, `${name.slice(0, name.length - extname(name).length)}-${digest.slice(0, 6)}${extname(name)}`];
  for (const candidate of candidates) {
    const absolute = join(deckDir, dirName, candidate);
    let existing: Buffer | null = null;
    try {
      if ((await stat(absolute)).isFile()) existing = await readFile(absolute);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (createHash("sha1").update(existing).digest("hex") === digest) return { src: `${dirName}/${candidate}`, absolute, info };
      continue; // 同名不同内容：试带摘要的名字
    }
    await writeBytesAtomic(absolute, bytes);
    return { src: `${dirName}/${candidate}`, absolute, info };
  }
  // 带摘要的名字也被占着且内容不同（摘要前 6 位撞车）：理论上不会，抛出来而不是覆盖
  throw new Error("图片文件名冲突，请换个文件名");
}
