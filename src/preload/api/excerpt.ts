/**
 * 摘抄的 contextBridge 面 —— 四层契约的第 3 层。三个方法（add / list / remove），
 * 契约在 shared/excerpt.ts。搜索与按会话过滤在 renderer 做（量小，list 一次拉全）。
 * 入参非法时主进程抛错，这里原样返回 rejected promise，调用方自己 catch。
 */
import { ipcRenderer } from "electron";
import {
  excerptChannels,
  type ExcerptAddRequest,
  type ExcerptAddResponse,
  type ExcerptListResponse,
  type ExcerptRemoveRequest,
  type ExcerptRemoveResponse,
} from "../../shared/excerpt.ts";

export const excerptApi = {
  /** 摘一段（幂等：同一会话 + 轮 + 角色 + 规整文字再摘，返回已有那条、duplicate = true） */
  add: (request: ExcerptAddRequest): Promise<ExcerptAddResponse> =>
    ipcRenderer.invoke(excerptChannels.add, request),
  /** 全部摘抄，新的在前；每条带出处会话标题（null = 会话已删，不可跳转） */
  list: (): Promise<ExcerptListResponse> => ipcRenderer.invoke(excerptChannels.list),
  /** 删一条；id 不在也返回 removed = false（连点两下的第二次同样当作已删） */
  remove: (request: ExcerptRemoveRequest): Promise<ExcerptRemoveResponse> =>
    ipcRenderer.invoke(excerptChannels.remove, request),
};
