/**
 * 设置页「LaTeX 论文」自查清单的**纯裁决**：探测结果 → 三行（名字 / 是否可用 / 一句人话）。
 *
 * 为什么要独立成模块：文案要按界面语言说，而主进程不知道用户选的是哪种语言。
 * 旧版把「这台电脑上没有找到 synctex 命令…」「pandoc … is too old…」直接写在主进程，
 * 于是中文界面里混进一整段英文（2026-11-27 Windows 实拍）。现在主进程只回事实
 * （路径 / 版本 / 门槛），这句话在这里按语言拼；FilesPanel 之外的组件也接不上 React，
 * `node --test` 要能单独验它。
 */
import type { LatexEnvCheckResult, LatexProbeResult } from "../../../../shared/latex.ts";

export type EnvRowId = "latexmk" | "synctex" | "chktex" | "pandoc";

export interface EnvRow {
  id: EnvRowId;
  /** 行名（已本地化） */
  name: string;
  ok: boolean;
  /** 右侧那一句：找到的路径 / 版本，或缺少时的说明 */
  detail: string;
}

/** 这一页要用到的文案（从 messages-zh / messages-en 的 latexSettings 取） */
export interface EnvRowTexts {
  latexmk: string;
  synctex: string;
  chktex: string;
  pandoc: string;
  probing: string;
  notFound: string;
  /** latexmk 探测失败时主进程给的那句话（已经是按平台写的英文 / 中文提示） */
  synctexMissing: string;
  chktexMissing: string;
  pandocMissing: string;
  pandocTooOld: (version: string, min: string) => string;
  pandocReady: (version: string, path: string) => string;
}

/**
 * 三行 + latexmk 一行。顺序即界面顺序：编译器在最上面，其余按「编译 → 定位 → 检查 → 导出」。
 *
 * `probe === null` / `env === null` 是「还在探测」——不是「没找到」，行里必须能分清，
 * 否则打开设置页的第一帧会把整台机器报成红的。
 */
export function envRowsOf(
  input: { probe: LatexProbeResult | null; env: LatexEnvCheckResult | null },
  texts: EnvRowTexts,
): EnvRow[] {
  const probe = input.probe;
  const rows: EnvRow[] = [
    {
      id: "latexmk",
      name: texts.latexmk,
      ok: probe?.ok === true,
      detail:
        probe === null
          ? texts.probing
          : probe.ok
            ? `${probe.latexmk ?? ""}（${probe.source ?? ""}）`
            : probe.message,
    },
  ];
  // 清单还没回来时给三行「探测中」的占位：行数恒定的界面不会在探测结束时跳一下
  const items = input.env?.items ?? [
    { id: "synctex" as const, ok: false, path: null },
    { id: "chktex" as const, ok: false, path: null },
    { id: "pandoc" as const, ok: false, path: null },
  ];
  const pending = input.env === null;
  for (const item of items) {
    if (item.id === "synctex") {
      rows.push({
        id: "synctex",
        name: texts.synctex,
        ok: item.ok,
        detail: pending ? texts.probing : item.ok ? (item.path ?? texts.notFound) : texts.synctexMissing,
      });
      continue;
    }
    if (item.id === "chktex") {
      rows.push({
        id: "chktex",
        name: texts.chktex,
        ok: item.ok,
        detail: pending ? texts.probing : item.ok ? (item.path ?? texts.notFound) : texts.chktexMissing,
      });
      continue;
    }
    const version = item.version ?? null;
    const path = item.path ?? null;
    rows.push({
      id: "pandoc",
      name: texts.pandoc,
      ok: item.ok,
      detail: pending
        ? texts.probing
        : item.ok
          ? texts.pandocReady(version ?? "", path ?? "")
          : version === null
            ? texts.pandocMissing
            : texts.pandocTooOld(version, item.minVersion ?? ""),
    });
  }
  return rows;
}
