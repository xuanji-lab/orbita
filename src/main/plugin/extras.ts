/**
 * 清单 `orbita.io` / `orbita.external` / `orbita.tuned` 的解析（Orbita 的清单扩展，给人看，不执行；
 * 类型见 shared/plugin-board.ts）。纯函数，不读盘。写得不对的项跳过并记一条问题，不整块丢、也不静默。
 */
import type { PluginProblem } from "../../shared/plugin.ts";
import {
  EMPTY_PLUGIN_IO,
  PLUGIN_EXTERNAL_KINDS,
  type PluginExternal,
  type PluginExternalKind,
  type PluginIo,
  type PluginIoItem,
} from "../../shared/plugin-board.ts";

/** 条数与字段长度上限：清单是不可信输入，详情页会逐项渲染（超长截断、不报错）。 */
const IO_MAX_ITEMS = 30;
const EXTERNAL_MAX_ITEMS = 20;
const PATH_MAX = 240;
const TEXT_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orbitaOf(manifest: Record<string, unknown>): Record<string, unknown> | null {
  const orbita = manifest["orbita"];
  return isRecord(orbita) ? orbita : null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function optionalText(value: unknown, where: string, problems: PluginProblem[], max: number, kind: PluginProblem["kind"]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    problems.push({ kind, detail: `${where}: not a string` });
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : clip(trimmed, max);
}

function optionalBool(value: unknown, where: string, problems: PluginProblem[]): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    problems.push({ kind: "external-invalid", detail: `${where}: not a boolean` });
    return null;
  }
  return value;
}

/** `orbita.io`：`{ reads: [{path, note?}], writes: [{path, note?, when?}] }`；每项也可以直接写成路径字符串。 */
export function parseIo(manifest: Record<string, unknown>, problems: PluginProblem[]): PluginIo {
  const orbita = orbitaOf(manifest);
  const raw = orbita?.["io"];
  if (raw === undefined) return EMPTY_PLUGIN_IO;
  if (!isRecord(raw)) {
    problems.push({ kind: "io-invalid", detail: "orbita.io: not an object" });
    return EMPTY_PLUGIN_IO;
  }
  const side = (key: "reads" | "writes"): PluginIoItem[] => {
    const list = raw[key];
    if (list === undefined) return [];
    const where = `orbita.io.${key}`;
    if (!Array.isArray(list)) {
      problems.push({ kind: "io-invalid", detail: `${where}: not an array` });
      return [];
    }
    if (list.length > IO_MAX_ITEMS) problems.push({ kind: "io-invalid", detail: `${where}: more than ${IO_MAX_ITEMS} items, the rest are ignored` });
    const items: PluginIoItem[] = [];
    list.slice(0, IO_MAX_ITEMS).forEach((entry, index) => {
      const at = `${where}[${index}]`;
      const record = typeof entry === "string" ? { path: entry } : entry;
      if (!isRecord(record)) {
        problems.push({ kind: "io-invalid", detail: `${at}: not an object` });
        return;
      }
      const path = typeof record["path"] === "string" ? record["path"].trim() : "";
      if (path === "") {
        problems.push({ kind: "io-invalid", detail: `${at}: path is required` });
        return;
      }
      items.push({
        path: clip(path, PATH_MAX),
        note: optionalText(record["note"], `${at}.note`, problems, TEXT_MAX, "io-invalid"),
        when: optionalText(record["when"], `${at}.when`, problems, TEXT_MAX, "io-invalid"),
      });
    });
    return items;
  };
  return { reads: side("reads"), writes: side("writes") };
}

/** `orbita.external`：`[{ name, kind: api|cli|mcp|service, account?, resident?, note? }]`。 */
export function parseExternal(manifest: Record<string, unknown>, problems: PluginProblem[]): PluginExternal[] {
  const raw = orbitaOf(manifest)?.["external"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push({ kind: "external-invalid", detail: "orbita.external: not an array" });
    return [];
  }
  if (raw.length > EXTERNAL_MAX_ITEMS) {
    problems.push({ kind: "external-invalid", detail: `orbita.external: more than ${EXTERNAL_MAX_ITEMS} items, the rest are ignored` });
  }
  const items: PluginExternal[] = [];
  raw.slice(0, EXTERNAL_MAX_ITEMS).forEach((entry, index) => {
    const at = `orbita.external[${index}]`;
    if (!isRecord(entry)) {
      problems.push({ kind: "external-invalid", detail: `${at}: not an object` });
      return;
    }
    const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
    if (name === "") {
      problems.push({ kind: "external-invalid", detail: `${at}: name is required` });
      return;
    }
    const kind = entry["kind"];
    if (typeof kind !== "string" || !(PLUGIN_EXTERNAL_KINDS as readonly string[]).includes(kind)) {
      problems.push({ kind: "external-invalid", detail: `${at}.kind: must be one of ${PLUGIN_EXTERNAL_KINDS.join(", ")}` });
      return;
    }
    items.push({
      name: clip(name, PATH_MAX),
      kind: kind as PluginExternalKind,
      account: optionalBool(entry["account"], `${at}.account`, problems),
      resident: optionalBool(entry["resident"], `${at}.resident`, problems),
      note: optionalText(entry["note"], `${at}.note`, problems, TEXT_MAX, "external-invalid"),
    });
  });
  return items;
}

/** `orbita.tuned`：true / false；没写 false；别的值记问题、当 false。 */
export function parseTuned(manifest: Record<string, unknown>, problems: PluginProblem[]): boolean {
  const raw = orbitaOf(manifest)?.["tuned"];
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    problems.push({ kind: "tuned-invalid", detail: "orbita.tuned: not a boolean" });
    return false;
  }
  return raw;
}
