/**
 * 编排页的候选版式（原型，等用户挑）。两个开关，**运行时可切**（不用重载页面——重载会丢掉在跑 / 等你的界面状态）：
 *   window.orbitaProto.set({ title: "header" })   // 或 "both"（缺省）
 *   window.orbitaProto.set({ avatar: "same" })    // 或 "seeded"（缺省）
 * 初值也可以从地址读：`?title=header&avatar=same`。
 * - title=both（缺省）：页头胶囊之外，页面左上还有大标题「<工作区名> 星系 ⌄」+ slogan（现状）；
 *   title=header：去掉大标题与切换箭头（换工作区靠侧栏），名字只在页头出现一次；slogan 只在这座星系还没有任何会话时留一行轻字
 *   （空态要有一句话告诉你这是哪儿，有内容后星系本身就是门面）。
 * - avatar=seeded（缺省）：没设计过的工作区按 id 取一套稳定的种子稿；avatar=same：全部同一颗默认主星（现状）。
 */
export type WsTitleVariant = "both" | "header";
export type AvatarVariant = "seeded" | "same";

export interface ProtoVariants {
  title: WsTitleVariant;
  avatar: AvatarVariant;
}

export function wsTitleVariantOf(search: string): WsTitleVariant {
  return new URLSearchParams(search).get("title") === "header" ? "header" : "both";
}

export function avatarVariantOf(search: string): AvatarVariant {
  return new URLSearchParams(search).get("avatar") === "same" ? "same" : "seeded";
}

/** 页头版里这一行 slogan 要不要出现：只在星系完全是空的时候（没有行星、没有碎石） */
export function showQuietSlogan(variant: WsTitleVariant, spec: { planets: readonly unknown[]; sessions: number }): boolean {
  return variant === "header" && spec.planets.length === 0 && spec.sessions === 0;
}

/** 合并补丁：只认合法值，坏值忽略 */
export function mergeVariants(current: ProtoVariants, patch: Partial<Record<keyof ProtoVariants, unknown>>): ProtoVariants {
  return {
    title: patch.title === "header" || patch.title === "both" ? patch.title : current.title,
    avatar: patch.avatar === "same" || patch.avatar === "seeded" ? patch.avatar : current.avatar,
  };
}
