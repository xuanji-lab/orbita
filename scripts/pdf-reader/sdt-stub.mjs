/**
 * `structured-document-text`（阅读模式的结构化文本）的空桩：构建阅读器时，webpack 把 reader 源码里
 * 所有指向这个子模块的 import 换成本文件（scripts/pdf-reader/webpack.orbita.cjs）。
 *
 * 为什么要桩：那个子模块没有许可证文件，而 reader 是**静态** import 它的——不桩掉，哪怕从不打开阅读模式，
 * 它的代码也会被编进 reader.js 随安装包分发。我们构建时干脆不拉这个子模块。
 *
 * 桩的形状：每个被 import 的名字都在这里有一个导出（webpack 开了 exportsPresence: "error"，
 * 升级 reader 多出一个新名字会让构建当场失败，逼人回来看它落在哪条路径上）。
 * - 函数一律「安全失败」：返回 null / 空数组 / false，不抛错；
 * - 两个版本号常量给 0（只在 SDT 包读取路径里比较，那条路径不会走到：我们不传 getSDTPack）。
 *
 * 这些函数在 reader 里只落在阅读模式、朗读分句、SDT 导航与语义覆盖层上；普通 PDF 的选字、批注、查找、
 * 缩放、翻页都不经过它们（调用点清单见引入阅读器那次提交的说明）。
 */

export const SDT_PACK_VERSION = 0;
export const SDT_SCHEMA_VERSION = 0;

// src/pages.js
export function getPageBlockSpan() {
  return null;
}

// src/range.js
export function compareRefs() {
  return 0;
}
export function refKey() {
  return "";
}
export function isLeafBlock() {
  return false;
}
export function getContentRangeBlockSpan() {
  return null;
}
export function walkContentRangeLeafBlocks() {}

// src/parts.js
export function getPartBoundarySeparator() {
  return "";
}
export function getPartChain() {
  return [];
}
export function shouldDropHardHyphenAtPartBoundary() {
  return false;
}

// src/read.js
export async function openStructuredDocumentTextPack() {
  return null;
}

// src/pack/format.js
export function findChunkIndex() {
  return -1;
}

// src/pdf/decode.js、src/pdf/utils.js
export function buildRunData() {
  return null;
}
export function parseTextMap() {
  return null;
}
export function isWhitespaceChar() {
  return false;
}

// src/dom/*
export function buildDomMapIndex() {
  return null;
}
export function findDomMapContaining() {
  return null;
}
export function generateDomMapSelector() {
  return null;
}
export function matchDomMapSelector() {
  return null;
}
export function nfcToOriginalLocal() {
  return null;
}
export function expandSelectorMap() {
  return null;
}
export function parseSelectorMapEntries() {
  return [];
}
export function resolveSelectorMap() {
  return null;
}
export function resolveSelectorMapRange() {
  return null;
}
