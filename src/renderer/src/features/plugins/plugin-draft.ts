/**
 * 草稿预览（agent 的 `preview_plugin` 扫过一个还没安装的插件文件夹）在 renderer 里的状态规则。
 * 纯函数，单独成文件只为可测。
 *
 * 草稿按**会话**记：同一时刻几条会话各在做各的插件，互不串。离开草稿视图（点返回）只清当前会话的那一条；
 * agent 再次 preview 同一个文件夹会重新进入（那是 agent 明确要给用户看）。
 */
export type PluginDrafts = ReadonlyMap<string, string>;

export function putDraft(drafts: PluginDrafts, sessionId: string, path: string): PluginDrafts {
  if (drafts.get(sessionId) === path) return drafts;
  return new Map(drafts).set(sessionId, path);
}

export function dropDraft(drafts: PluginDrafts, sessionId: string): PluginDrafts {
  if (!drafts.has(sessionId)) return drafts;
  const next = new Map(drafts);
  next.delete(sessionId);
  return next;
}

/** 这条会话此刻有没有要看的草稿；没打开会话（首页）没有。 */
export function draftOf(drafts: PluginDrafts, sessionId: string | null): string | null {
  return sessionId === null ? null : (drafts.get(sessionId) ?? null);
}

/**
 * 收到 `pluginDraft` 事件：要不要把右栏切到插件页的「正在做」视图。
 * 只在**正看着该会话**且实验功能 plugins 开着时切——别的会话的草稿只记下来，等用户切过去、打开插件页再看。
 */
export function shouldOpenDraft(args: { eventSessionId: string; viewedSessionId: string | null; pluginsEnabled: boolean }): boolean {
  return args.pluginsEnabled && args.viewedSessionId !== null && args.eventSessionId === args.viewedSessionId;
}
