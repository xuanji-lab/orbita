/**
 * 新内核（pi-durable）的主进程侧：开发开关，与删会话时连带删它的库。**纯模块**，`node --test` 直接测。
 *
 * 开关：环境变量 `ORBITA_DURABLE_KERNEL=1`，**默认关**。关着时 index.ts 不建 KernelHost，
 * 会话删除 / 工具禁区两处都走与基线逐字节相同的代码（见各调用点的三元式）。
 *
 * 开着时（这一步的全部行为）：会话库目录 `<userData>/durable` 进工具禁区；删一棵会话树时连它的库文件一起删。
 * 旧会话**不在打开时迁**：迁移在新内核第一次为这条会话发消息时做（src/agent/kernel.ts 的 turn，发之前比对原件
 * 指纹、过期就重迁）。这一步对话主循环仍是旧内核，主进程不拉起 kernel 进程、不驱动它跑轮——kernel 进程只由
 * 脚本直驱；主循环切过来那一步，主进程在这里拉起它、把开轮命令转过去。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { KERNEL_LIBRARY_NAME } from "../../shared/kernel.ts";

/** 开发开关的环境变量名 */
export const DURABLE_KERNEL_FLAG = "ORBITA_DURABLE_KERNEL";

/** 开关只认字面量 "1"：别的值（空串、"0"、"true"）一律当关——宁可没开，不要误开 */
export function durableKernelEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DURABLE_KERNEL_FLAG] === "1";
}

export class KernelHost {
  private readonly dir: string;

  /** dir：库目录（`<userData>/durable`） */
  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * 删一棵会话树的库：库文件与 WAL 两个旁文件。库不在也算成功。这一步没有进程开着库
   * （kernel 进程只由脚本直驱），直接删文件。
   */
  async drop(library: string): Promise<void> {
    if (!KERNEL_LIBRARY_NAME.test(library)) throw new Error(`invalid library name "${library}"`);
    for (const suffix of ["", "-wal", "-shm"]) await rm(join(this.dir, `${library}${suffix}`), { force: true });
  }
}
