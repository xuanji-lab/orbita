/**
 * 派活时的「能力集」（2026-11-17 用户：「允许主 Agent 在发配子 Agent 的时候去定义它的插件集、它的能力集」）。
 *
 * 一件活（子会话）带哪些模块，由派它的人在 delegate 时定，落进子会话 meta，之后不变（工具集一变就是另一个提示前缀）。
 * 模块按代码里真实的工具分组（agent/turn-tools.ts 的每一组）：
 * - 基础（恒带，不写进清单）：read / write / edit / bash、update_plan、update_goal、子会话的 report_to_parent；
 * - 可选模块：见 CAPABILITY_MODULES；
 * - 用户装的：`skill:<slug 或名字>`、`mcp:<服务名>`、`plugin:<插件名>`（插件 = 它带的技能与 MCP）。
 *
 * 三种写法，语义不同（缺席与空数组必须分开）：
 * - 缺席（undefined）：全带——与这个功能之前一字不差（不改提示词的老路径、老 meta、回滚到旧版都是这一种）；
 * - `[]` 或只列模块：基础 + 列出的那几样；
 * - `["none"]`：纯聊天——不注册任何工具，系统提示只留身份与回复语言；这一轮的最终回答由主进程当「完成」交回派它的人。
 *
 * 纯模块：不 import electron / node，node --test 直接测。
 */

/** 可选模块 id。顺序就是清单的规范顺序（落 meta、拼提示都按它排：同一能力集的两件活前缀逐字节相同） */
export const CAPABILITY_MODULES = ["pdf-docx", "image", "browser", "docs-slides", "terminal", "store", "tasks"] as const;
export type CapabilityModule = (typeof CAPABILITY_MODULES)[number];

/** 纯聊天的字面量：不和「没给参数 = 全带」「空数组 = 只带基础」混 */
export const CHAT_ONLY = "none";

/** 用户装的能力的三种前缀 */
export const CAPABILITY_PREFIXES = ["skill:", "mcp:", "plugin:"] as const;

/** 给模型看的模块说明（delegate 参数说明、子会话通道说明、缺模块回执都用它） */
export const MODULE_SUMMARY: Readonly<Record<CapabilityModule, string>> = {
  "pdf-docx": "read_pdf / cite_pdf / read_docx (PDF and Word files)",
  image: "show_image (show pictures to the user)",
  browser: "the built-in web browser (open, read and operate web pages)",
  "docs-slides": "slides_* and doc_* (presentations and documents in the side panel)",
  terminal: "terminal_* (visible terminal tabs the user can watch)",
  store: "create_skill / add_mcp_server (configure the agent itself)",
  tasks: "read_task (read other sessions' transcripts)",
};

/** 给人看的模块名（小卡「带了：…」） */
export const MODULE_LABEL_ZH: Readonly<Record<CapabilityModule, string>> = {
  "pdf-docx": "读 PDF 与 Word",
  image: "给你看图",
  browser: "浏览器",
  "docs-slides": "文档与幻灯片",
  terminal: "终端",
  store: "改智能体配置",
  tasks: "读别的会话",
};

export const MODULE_LABEL_EN: Readonly<Record<CapabilityModule, string>> = {
  "pdf-docx": "PDF and Word",
  image: "images",
  browser: "browser",
  "docs-slides": "documents and slides",
  terminal: "terminal",
  store: "agent settings",
  tasks: "other sessions",
};

export function isCapabilityModule(value: string): value is CapabilityModule {
  return (CAPABILITY_MODULES as readonly string[]).includes(value);
}

export type CapabilitiesParse = { ok: true; value: string[] | undefined } | { ok: false; error: string };

/**
 * 校验并规范化 delegate 给的能力集。缺席 → `value: undefined`（全带）。
 * 规范化：去空白、去重、`base` 丢掉（恒带）、模块按 CAPABILITY_MODULES 排、用户装的按字典序排在模块后面。
 * 不认识的模块、`none` 和别的混写、`skill:` 后面没名字 → 错误（写给模型看，列出可用的）。
 */
export function parseCapabilities(raw: unknown): CapabilitiesParse {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    return { ok: false, error: '"capabilities" must be a list of strings.' };
  }
  const entries = [...new Set((raw as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "" && entry !== "base"))];
  if (entries.includes(CHAT_ONLY)) {
    if (entries.length > 1) return { ok: false, error: `"${CHAT_ONLY}" means chat only and cannot be combined with other capabilities.` };
    return { ok: true, value: [CHAT_ONLY] };
  }
  const modules: CapabilityModule[] = [];
  const installed: string[] = [];
  for (const entry of entries) {
    if (isCapabilityModule(entry)) {
      modules.push(entry);
      continue;
    }
    const prefix = CAPABILITY_PREFIXES.find((candidate) => entry.startsWith(candidate));
    if (prefix !== undefined) {
      if (entry.slice(prefix.length).trim() === "") return { ok: false, error: `"${entry}" needs a name after "${prefix}".` };
      installed.push(`${prefix}${entry.slice(prefix.length).trim()}`);
      continue;
    }
    return {
      ok: false,
      error: `Unknown capability "${entry}". Use module ids (${CAPABILITY_MODULES.join(", ")}), skill:<name>, mcp:<server>, plugin:<name>, or ["${CHAT_ONLY}"] for chat only.`,
    };
  }
  modules.sort((a, b) => CAPABILITY_MODULES.indexOf(a) - CAPABILITY_MODULES.indexOf(b));
  return { ok: true, value: [...modules, ...[...new Set(installed)].sort()] };
}

/** 读 meta 用：坏值当缺席（全带）——一份坏 meta 不该让一件活什么都不能做 */
export function capabilitiesField(raw: unknown): { capabilities?: string[] } {
  if (raw === undefined) return {};
  const parsed = parseCapabilities(raw);
  return parsed.ok && parsed.value !== undefined ? { capabilities: parsed.value } : {};
}

export function isChatOnly(capabilities: readonly string[] | undefined): boolean {
  return capabilities !== undefined && capabilities.length === 1 && capabilities[0] === CHAT_ONLY;
}

/** 这一组模块带不带：缺席（全带）恒带；纯聊天恒不带 */
export function hasModule(capabilities: readonly string[] | undefined, module: CapabilityModule): boolean {
  return capabilities === undefined || capabilities.includes(module);
}

/** 清单里点名的用户装的能力（去掉前缀），比如 `names(caps, "skill:")` */
export function namedInstalled(capabilities: readonly string[], prefix: (typeof CAPABILITY_PREFIXES)[number]): string[] {
  return capabilities.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
}

/**
 * 小卡一行「带了：浏览器、读 PDF 与 Word」的数据：只列可选模块与用户装的（基础不写）；全带 / 只带基础 = null（不画）；纯聊天 = 「只聊天」。
 */
export function capabilitiesLine(capabilities: readonly string[] | undefined, language: "zh" | "en"): string | null {
  if (capabilities === undefined) return null;
  if (isChatOnly(capabilities)) return language === "zh" ? "只聊天，不动文件" : "Chat only, no file access";
  const labels = language === "zh" ? MODULE_LABEL_ZH : MODULE_LABEL_EN;
  const names = capabilities.map((entry) => (isCapabilityModule(entry) ? labels[entry] : entry.slice(entry.indexOf(":") + 1)));
  if (names.length === 0) return null;
  return language === "zh" ? `带了：${names.join("、")}` : `Has: ${names.join(", ")}`;
}
