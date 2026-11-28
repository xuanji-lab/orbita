/**
 * 内置默认模板 —— pandoc 自带的 `reference.docx`，我们只做一件事：把东亚字体钉成
 * 宋体 / 黑体，免得在没装 Office 字体的机器上中文变成方框或等线。
 *
 * 为什么不自己写一份 docx：pandoc 的 reference.docx 里有全套标准样式（Title /
 * Heading 1–6 / Body Text / Compact / Table / Image Caption …），这些正是
 * `--reference-doc` 与目录 / 公式编号要用的；手写一份只会少几个样式，然后在校样
 * 阶段一个一个补。用户不提供模板时它就是「内置默认样式」。
 *
 * 生成时机：第一次导出 / 第一次打开设置页。缓存到 userData（文件名带 pandoc 版本，
 * 换版本自然重建），原子写。生成失败不抛到底——调用方退回「不用 reference-doc」，
 * 这是 pandoc 自己的默认样式，仍然能出 docx。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rewriteZipEntries } from "../docx/zip.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { formatPandocVersion, type PandocVersion } from "../../shared/docx-export.ts";

export interface DefaultTemplateOptions {
  /** 缓存根（通常是 `<userData>/docx-templates`） */
  cacheDir: string;
  pandocPath: string;
  version: PandocVersion;
  /** `pandoc --print-default-data-file reference.docx` 的字节；失败回 null */
  printReference: (pandocPath: string) => Promise<Uint8Array | null>;
}

export interface DefaultTemplateResult {
  path: string | null;
  error: string | null;
}

/** 让中日韩文字落到宋体（正文）/ 黑体（标题）——主题字体里的 Hans 槽位 */
function patchTheme(themeXml: string): string {
  return themeXml
    .replace(/(<a:majorFont>[\s\S]*?<a:ea typeface=")(" *\/>)/, "$1黑体$2")
    .replace(/(<a:majorFont>[\s\S]*?<a:font script="Hans" typeface=")[^"]*(")/, "$1黑体$2")
    .replace(/(<a:minorFont>[\s\S]*?<a:ea typeface=")(" *\/>)/, "$1宋体$2")
    .replace(/(<a:minorFont>[\s\S]*?<a:font script="Hans" typeface=")[^"]*(")/, "$1宋体$2");
}

/** 文档默认 run 属性里补 eastAsia：主题字体缺失时仍有确定的中文字体 */
function patchStyles(stylesXml: string): string {
  if (/<w:docDefaults>[\s\S]*?<w:rFonts[^>]*w:eastAsia="/.test(stylesXml)) return stylesXml;
  return stylesXml.replace(
    /(<w:docDefaults>[\s\S]*?<w:rFonts\b)([^>]*?)(\/>)/,
    (whole, head: string, attrs: string, tail: string) => {
      if (/w:eastAsia=/.test(attrs)) return whole;
      return `${head}${attrs} w:eastAsia="宋体"${tail}`;
    },
  );
}

/** 把 pandoc 的 reference.docx 改成中文默认模板（纯字节 → 字节） */
export function makeChineseDefaultTemplate(reference: Uint8Array): Uint8Array {
  try {
    return rewriteZipEntries(reference, ["word/theme/theme1.xml", "word/styles.xml"], (name, text) =>
      name === "word/theme/theme1.xml" ? patchTheme(text) : patchStyles(text),
    );
  } catch (error) {
    // 结构异常（ZIP64 等）不值得让导出失败：字体退回主题默认，样式照样可用
    console.warn("[docx-export] 默认模板字体补丁失败，使用 pandoc 原始 reference.docx", error);
    return reference;
  }
}

/** 缓存路径：pandoc 版本进文件名，升级 pandoc 后自动重建 */
export function defaultTemplatePath(cacheDir: string, version: PandocVersion): string {
  return join(cacheDir, `reference-${formatPandocVersion(version)}.docx`);
}

/**
 * 取（必要时生成）默认模板。缓存命中要先确认文件真的存在且不是一个空文件——
 * 上一次生成到一半被杀的半截模板比「重新生成」更难查。
 */
export async function ensureDefaultTemplate(options: DefaultTemplateOptions): Promise<DefaultTemplateResult> {
  const target = defaultTemplatePath(options.cacheDir, options.version);
  try {
    const stats = await stat(target);
    if (stats.isFile() && stats.size > 1024) return { path: target, error: null };
  } catch {
    // 没缓存：往下生成
  }

  try {
    const reference = await options.printReference(options.pandocPath);
    if (reference === null || reference.byteLength < 1024) {
      return { path: null, error: "pandoc did not return its built-in reference.docx" };
    }
    const patched = makeChineseDefaultTemplate(reference);
    await mkdir(dirname(target), { recursive: true });
    await writeBytesAtomic(target, patched);
    return { path: target, error: null };
  } catch (cause) {
    return { path: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** 读默认模板字节（设置页体检用） */
export async function readDefaultTemplate(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}
