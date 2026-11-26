/**
 * 编排侧栏最前那一行的名字：它只装「不属于任何工作区」的会话，和各工作区平级，不是软件级的总入口
 * （2026-11-24 用户选的方案）。没有工作区就没有主智能体、也就没有主星——头像是一小撮碎石。
 * 名字放这里，用户想改只改这一处（messages 的 agents.home 读它）。
 */
export const INTERSTELLAR_NAME = { zh: "星际空间", en: "Interstellar" } as const;
