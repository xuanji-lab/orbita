/**
 * 编排页的候选版式（原型，等用户挑）。两个开关，**运行时可切**（不用重载页面——重载会丢掉在跑 / 等你的界面状态）：
 *   window.orbitaProto.set({ title: "both" })     // 或 "header"（缺省）
 *   window.orbitaProto.set({ avatar: "same" })    // 或 "seeded"（缺省）
 * 初值也可以从地址读：`?title=both&avatar=same`。
 * - title=header（缺省，2026-11-24 主会话定）：去掉大标题、切换箭头与 slogan（换工作区靠侧栏），名字只在页头出现一次。slogan 不留：它是每个工作区都一样的
 *   品牌句，不说这个工作区的事；空星系下一步该做什么由星系下面那一句「还没有派出的活，在下面写一件事」说；
 *   title=both：页头胶囊之外，页面左上还有大标题「<工作区名> 星系 ⌄」+ slogan（第一版的样子，留作对比）。
 * - avatar=seeded（缺省）：没设计过的工作区按 id 取一套稳定的种子稿；avatar=same：全部同一颗默认主星（现状）。
 */
export type WsTitleVariant = "both" | "header";
export type AvatarVariant = "seeded" | "same";

export interface ProtoVariants {
  title: WsTitleVariant;
  avatar: AvatarVariant;
}

export function wsTitleVariantOf(search: string): WsTitleVariant {
  return new URLSearchParams(search).get("title") === "both" ? "both" : "header";
}

export function avatarVariantOf(search: string): AvatarVariant {
  return new URLSearchParams(search).get("avatar") === "same" ? "same" : "seeded";
}

/** 合并补丁：只认合法值，坏值忽略 */
export function mergeVariants(current: ProtoVariants, patch: Partial<Record<keyof ProtoVariants, unknown>>): ProtoVariants {
  return {
    title: patch.title === "header" || patch.title === "both" ? patch.title : current.title,
    avatar: patch.avatar === "same" || patch.avatar === "seeded" ? patch.avatar : current.avatar,
  };
}
