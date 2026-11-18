/**
 * Office 预览的刷新令牌（渲染视图 / 数据视图各一个计数器）。
 *
 * 为什么单独一个纯模块：刷新链路有三条触发源——手动刷新、agent 改完（`office:changed`）、
 * 整批回退——它们都必须让**两个视图一起重读**。回退曾经只 bump 数据网格、并且把视图切到
 * 数据模式，结果「回退后渲染视图要手动切一次才回来」（2026-11-17 验收 BUG）。把「一次
 * 文件变化 → 两边令牌 +1、模式不动」收成一个函数，两个视图共用，单测钉住。
 */
export interface OfficeReloadState {
  /** 渲染视图（OfficeCLI `view html`）的令牌 */
  render: number;
  /** 数据视图（网格 / 大纲）的令牌 */
  data: number;
}

export const OFFICE_RELOAD_INITIAL: OfficeReloadState = { render: 0, data: 0 };

/**
 * 一次「这份文件变了」：编辑落盘、整批回退、手动刷新都走这里。
 * **两个令牌同时 +1**（回退与编辑对称），**模式由调用方保持不动**——用户正看着渲染视图，
 * 回退后就应该在原地重新渲染，而不是被切到网格。
 */
export function bumpOfficeReload(state: OfficeReloadState): OfficeReloadState {
  return { render: state.render + 1, data: state.data + 1 };
}
