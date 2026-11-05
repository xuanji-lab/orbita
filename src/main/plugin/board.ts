/**
 * 清单 `orbita.board` 的解析（纯函数，不读盘；类型与字段规格见 shared/plugin-board.ts）。
 *
 * 写得不对的卡（id 不合规 / 重复、尺寸不认识、缺 template）跳过并记一条 `board-invalid`，不整块拒；
 * 没有一张能用的卡，整块 board 为 null。读到已作废的 `orbita.panel` 记 `panel-renamed`，不再渲染它。
 * 路径只是清单原文：能不能读、在不在插件根内由 panel.ts 的定位函数在载入时判。
 */
import type { PluginProblem } from "../../shared/plugin.ts";
import {
  BOARD_CARD_ID_PATTERN,
  BOARD_MAX_CARDS,
  isBoardCardSize,
  type PluginBoardCardDecl,
  type PluginBoardInfo,
} from "../../shared/plugin-board.ts";

const TITLE_MAX = 80;
const NOTE_MAX = 200;
const PATH_MAX = 400;
/** repeat 只认顶层属性名 */
const REPEAT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function parseBoard(manifest: Record<string, unknown>, fallbackTitle: string, problems: PluginProblem[]): PluginBoardInfo | null {
  const orbita = manifest["orbita"];
  if (!isRecord(orbita)) return null;
  if (orbita["panel"] !== undefined) {
    problems.push({ kind: "panel-renamed", detail: "orbita.panel" });
  }
  const raw = orbita["board"];
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    problems.push({ kind: "board-invalid", detail: "orbita.board: not an object" });
    return null;
  }
  const list = raw["cards"];
  if (!Array.isArray(list)) {
    problems.push({ kind: "board-invalid", detail: "orbita.board.cards: not an array" });
    return null;
  }
  if (list.length > BOARD_MAX_CARDS) {
    problems.push({ kind: "board-invalid", detail: `orbita.board.cards: more than ${BOARD_MAX_CARDS} cards, the rest are ignored` });
  }
  const cards: PluginBoardCardDecl[] = [];
  const seen = new Set<string>();
  list.slice(0, BOARD_MAX_CARDS).forEach((entry, index) => {
    const card = parseCard(entry, `orbita.board.cards[${index}]`, seen, problems);
    if (card !== null) {
      seen.add(card.id);
      cards.push(card);
    }
  });
  if (cards.length === 0) return null;
  const title = typeof raw["title"] === "string" && raw["title"].trim() !== "" ? clip(raw["title"].trim(), TITLE_MAX) : fallbackTitle;
  let spec: string | null = null;
  if (raw["spec"] !== undefined && raw["spec"] !== null) {
    if (typeof raw["spec"] === "string" && raw["spec"].trim() !== "") spec = clip(raw["spec"].trim(), PATH_MAX);
    else problems.push({ kind: "board-invalid", detail: "orbita.board.spec: not a non-empty string" });
  }
  return { title, spec, cards };
}

function parseCard(entry: unknown, where: string, seen: ReadonlySet<string>, problems: PluginProblem[]): PluginBoardCardDecl | null {
  const bad = (detail: string): null => {
    problems.push({ kind: "board-invalid", detail: `${where}${detail}` });
    return null;
  };
  if (!isRecord(entry)) return bad(": not an object");
  const id = entry["id"];
  if (typeof id !== "string" || !BOARD_CARD_ID_PATTERN.test(id)) return bad(".id: must match [a-z0-9-]{1,32}");
  if (seen.has(id)) return bad(`.id: duplicate "${id}"`);
  const size = entry["size"];
  if (!isBoardCardSize(size)) return bad(`.size: must be one of 1x1, 2x1, 1x2, 2x2 (card "${id}")`);
  const template = entry["template"];
  if (typeof template !== "string" || template.trim() === "") return bad(`.template: required (card "${id}")`);

  const optional = (key: "data" | "sample" | "note" | "title", max: number): string | null => {
    const value = entry[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      problems.push({ kind: "board-invalid", detail: `${where}.${key}: not a string (card "${id}")` });
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : clip(trimmed, max);
  };
  const data = optional("data", PATH_MAX);
  const sample = optional("sample", PATH_MAX);
  let repeat: string | null = null;
  const rawRepeat = entry["repeat"];
  if (rawRepeat !== undefined && rawRepeat !== null) {
    if (typeof rawRepeat !== "string" || !REPEAT_KEY.test(rawRepeat)) {
      problems.push({ kind: "board-invalid", detail: `${where}.repeat: must be a top-level property name (card "${id}")` });
    } else if (data === null && sample === null) {
      problems.push({ kind: "board-invalid", detail: `${where}.repeat: needs data or sample (card "${id}")` });
    } else {
      repeat = rawRepeat;
    }
  }
  return {
    id,
    title: optional("title", TITLE_MAX) ?? id,
    size,
    note: optional("note", NOTE_MAX),
    template: clip(template.trim(), PATH_MAX),
    data,
    sample,
    repeat,
  };
}
