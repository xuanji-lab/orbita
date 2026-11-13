import type { FileRoot } from "@shared/files";
import type { PdfCitation } from "@shared/pdf-quote";
import { pathWithin } from "../../../../shared/path.ts";

/**
 * PDF 引用跳转请求的消费裁决（纯函数，FilesPanel 的 citeFocus effect 是它的薄适配）。
 *
 * 背景（2026-10-18 修的跨会话误报）：`citeFocus` 是 App 级一次性请求，token 只增不清；
 * FilesPanel 的消费守卫 `consumedCiteRef` 是组件内 ref——面板关掉重开（App 按
 * `shownPanel` 换 key 重挂）就归零，旧会话的请求会被拿来对**新会话**的根重判一次，
 * 判出 citeOutside 红字挂在无关会话上。裁决在这里把「请求属于哪条会话」写进数据：
 * 请求出生时带上主槽会话戳，换会话后即作废（drop），只有「在当前会话里点的引用」
 * 才有资格报「打不开」或开标签。
 */

/** App 递进来的请求：比 PdfJump 多一枚「出生会话」戳（App 的 mainOpenId，null 形） */
export interface CiteFocusRequest {
  citation: PdfCitation;
  /** 单调递增；同一条引用连点每次都是新 token */
  token: number;
  /** 点击发生时主槽正看着的会话（null = 还没有会话）。结构兼容 PdfJump 的超集 */
  session: string | null;
}

/** 一次消费的结论；idle / wait 不消费 token，其余三种都算消费掉（一次性请求） */
export type CiteFocusOutcome =
  | { kind: "idle" }
  /** 根清单还没回来：先不定论，等下一次 roots 变化再判 */
  | { kind: "wait" }
  /** 请求属于别的会话：作废，不报错也不打开 */
  | { kind: "drop" }
  /** 在当前会话里点的外面文件：面板顶部报 citeOutside */
  | { kind: "outside" }
  /** 这份 PDF 本会话引用过（有 cited 根），但文件已被删 / 挪走：面板顶部报 citeMissing，别说成「看不到」 */
  | { kind: "missing" }
  /** 找到宿主根（返回根路径）：开标签并跳转到原文 */
  | { kind: "open"; root: string };

/**
 * 裁决一条 citeFocus 请求此刻该怎么处理。调用方（FilesPanel）拿结论去改自己的
 * state；token 的「是否已消费」也在这里判——除 idle / wait 外都应记下已消费。
 */
export function decideCiteFocus(input: {
  request: CiteFocusRequest | null;
  /** 已消费的 token（FilesPanel 的 consumedCiteRef.current） */
  consumedToken: number | null;
  /** 主槽此刻的会话（与请求的 session 同一 null 形口径） */
  session: string | null;
  /**
   * 所有能当宿主的根：画进树的根 + 不进树的附件副本根 + 本会话引用过的 PDF（cited，
   * 每个文件一根，根路径就是文件本身）
   */
  roots: readonly FileRoot[];
  /** 根清单第一读是否在途（在途时判「不在根内」会误报） */
  rootsLoading: boolean;
}): CiteFocusOutcome {
  const { request, consumedToken, session } = input;
  if (request === null || consumedToken === request.token) return { kind: "idle" };
  // 会话戳对不上 = 这条请求不是在现在这条会话里点的：作废（消费掉），换会话回来
  // 也不重放——标签页本来就不随会话恢复（FilesPanel 切会话清标签的既有设计）
  if (request.session !== session) return { kind: "drop" };
  const owner = input.roots.find((root) => root.exists && pathWithin(root.path, request.citation.path));
  if (owner !== undefined) return { kind: "open", root: owner.path };
  if (input.rootsLoading) return { kind: "wait" };
  // 本会话引用过、但文件已不在盘上：与「在会话看不到的目录里」是两回事，分开说
  const gone = input.roots.some(
    (root) => root.kind === "cited" && !root.exists && pathWithin(root.path, request.citation.path),
  );
  return gone ? { kind: "missing" } : { kind: "outside" };
}
