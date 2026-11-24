/**
 * 能力（插件 / 技能 / MCP / 连接器）的图标：**按能力自己取，不按种类取**——
 * 以前每一行都是同一块橙积木（插件）/ 绿书（技能）/ 蓝插头（MCP），七十多行看不出谁是谁（2026-11-22 用户：
 * 「icon 都感觉非常的不好看……最吸引人的应该是 icon 和能力的名字」）。纯函数，列表行、卡片、详情头与
 * 「/ + 空格」选取态共用这一处，别的地方不另写一套。
 *
 * 取法，先到先得：
 * 1. 连接器：名字（或 MCP 服务名）认得出连接目录里的品牌 → 用目录里配好的品牌标（connector-logos）。
 * 2. 厂商：名字里有已登记的厂商（Figma / Google / Obsidian / Qwen……）→ vendor-logos 里的标。
 *    只看**名字**，不看描述——描述里随口提到 GitHub 的技能不该顶着 GitHub 的标。
 * 3. 关键词：名字、再描述里的词（论文 → book-open、演示 → presentation……）→ 一枚 lucide。
 * 4. 都没有：按种类给一枚中性的（技能 scroll-text、插件 blocks、MCP plug）。
 * lucide 图标放在淡底方块上，淡底色按名字**稳定**取自现有的几种类别色（同一能力永远同一色）。
 *
 * 契约里没有 `icon` 字段（plugin.json / SKILL.md 都没声明过），所以这里没有「作者自己指定」那一档；
 * 要加是个新契约，见 PR 说明里的建议，不在这里悄悄发明。
 */
import { CONNECTORS, type ConnectorEntry } from "../../../../shared/connectors.ts";
import type { PluginOrigin } from "../../../../shared/plugin.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import type { IconName } from "../../shell/Icon.tsx";

/** 取图标要看的事实：来源、显示名、描述、标识（技能目录名 / MCP 服务名 / 插件标识，来自视图 id）。 */
export interface AbilityIdentity {
  origin: PluginOrigin;
  name: string;
  description: string;
  /** 视图 id 里的标识；拿不到时给空串 */
  key: string;
}

/** lucide 图标的淡底色：现有的三种类别色（文档蓝 / 演示橙 / 表格绿）+ 一档中性灰。不新造颜色语义。 */
export const ICON_TONES = ["doc", "slides", "sheet", "neutral"] as const;
export type IconTone = (typeof ICON_TONES)[number];

/** vendor-logos 里登记过的厂商标（键 = 文件名去扩展名）。 */
export const VENDORS = [
  "anthropic",
  "claude",
  "cloudflare",
  "capcut",
  "deepseek",
  "elevenlabs",
  "exa",
  "figma",
  "firecrawl",
  "gemini",
  "google",
  "huggingface",
  "kimi",
  "microsoft",
  "minimax",
  "obsidian",
  "openai",
  "perplexity",
  "qwen",
  "tavily",
  "vercel",
  "zhipu",
] as const;
export type VendorKey = (typeof VENDORS)[number];

export type AbilityIconSpec =
  | { kind: "connector"; entry: ConnectorEntry }
  | { kind: "vendor"; vendor: VendorKey }
  | { kind: "lucide"; icon: IconName; tone: IconTone };

/** 小写后按「非字母数字」切开；中文连续段原样保留成一个词。 */
export function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token !== "");
}

// ───────────────────────────── 连接器 ─────────────────────────────

/** 目录条目 → 名字里能认出它的词（英文小写 / 中文原样）。目录的 id 本身永远算。 */
const CONNECTOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  feishu: ["feishu", "lark", "飞书"],
  dingtalk: ["dingtalk", "dws", "钉钉"],
  wecom: ["wecom", "企业微信"],
  github: ["github"],
  tabbit: ["tabbit"],
  "tencent-docs": ["腾讯文档", "tencent-docs"],
  ctrip: ["ctrip", "携程"],
  "baidu-netdisk": ["百度网盘", "baidu-netdisk", "baidunetdisk"],
  notion: ["notion"],
  supabase: ["supabase"],
  pangram: ["pangram"],
};

/**
 * 这个能力是不是目录里的某个连接器：MCP 的服务名等于目录写进 mcp.json 的名字（`github` / `notion` / `tencent-docs`），
 * 或者名字 / 标识里有目录条目的词。认不出为 undefined。
 */
export function connectorOf(identity: Pick<AbilityIdentity, "origin" | "name" | "key">): ConnectorEntry | undefined {
  if (identity.origin === "user-mcp") {
    const byServer = CONNECTORS.find((entry) => entry.mcp?.serverName === identity.key);
    if (byServer !== undefined) return byServer;
  }
  const haystack = `${identity.key} ${identity.name}`.toLowerCase();
  const tokens = new Set(tokensOf(haystack));
  return CONNECTORS.find((entry) => {
    const words = CONNECTOR_ALIASES[entry.id] ?? [entry.id];
    return words.some((word) => (/[\u4e00-\u9fff-]/.test(word) ? haystack.includes(word) : tokens.has(word)));
  });
}

// ───────────────────────────── 厂商 ─────────────────────────────

/** 词 → 厂商标。词是名字切出来的 token，整词相等才算（`exa` 不能命中 `example`）。 */
const VENDOR_WORDS: ReadonlyArray<readonly [VendorKey, readonly string[]]> = [
  ["claude", ["claude"]],
  ["anthropic", ["anthropic"]],
  ["openai", ["openai", "gpt", "codex", "chatgpt"]],
  ["gemini", ["gemini"]],
  ["google", ["google", "gmail", "gcal"]],
  ["kimi", ["kimi", "moonshot"]],
  ["qwen", ["qwen", "通义", "千问"]],
  ["deepseek", ["deepseek"]],
  ["minimax", ["minimax"]],
  ["zhipu", ["zhipu", "bigmodel", "智谱"]],
  ["figma", ["figma"]],
  ["obsidian", ["obsidian"]],
  ["huggingface", ["huggingface", "hf"]],
  ["elevenlabs", ["elevenlabs"]],
  ["capcut", ["capcut", "剪映"]],
  ["perplexity", ["perplexity"]],
  ["firecrawl", ["firecrawl"]],
  ["tavily", ["tavily"]],
  ["exa", ["exa"]],
  ["cloudflare", ["cloudflare"]],
  ["vercel", ["vercel"]],
  ["microsoft", ["microsoft", "outlook", "onedrive", "sharepoint"]],
];

export function vendorOf(identity: Pick<AbilityIdentity, "name" | "key">): VendorKey | undefined {
  const tokens = new Set([...tokensOf(identity.key), ...tokensOf(identity.name)]);
  const hit = VENDOR_WORDS.find(([, words]) => words.some((word) => tokens.has(word)));
  return hit?.[0];
}

// ───────────────────────────── 关键词 → lucide ─────────────────────────────

/**
 * 关键词表（先到先得，所以**更具体的在前**：git 在 code 前、电子表格在数据库前）。
 * `en` 是英文词前缀（`slide` 命中 slides / slideshow；词尾带 `$` = 整词相等），`zh` 是中文子串。写表就是给能力挑图标，
 * 加一行 = 一类能力有了自己的图；testcase 在 ability-icon.test.ts。
 */
export const ICON_KEYWORDS: ReadonlyArray<{ icon: IconName; en: readonly string[]; zh: readonly string[] }> = [
  { icon: "presentation", en: ["slide", "deck", "ppt$", "presentation", "keynote"], zh: ["演示", "幻灯", "汇报"] },
  { icon: "table", en: ["table", "spreadsheet", "excel", "xlsx", "csv", "dataset"], zh: ["表格", "数据表"] },
  { icon: "chart-column", en: ["chart", "plot", "visuali", "analytics", "dashboard", "statistic"], zh: ["可视化", "图表", "统计"] },
  { icon: "book-open", en: ["paper", "literature", "citation", "cite", "academic", "bibliograph", "reading", "scholar", "manuscript", "thesis", "readme", "book"], zh: ["论文", "文献", "阅读", "读书", "引用", "学术", "综述"] },
  { icon: "sigma", en: ["math", "theorem", "proof", "latex", "equation", "diffusion", "ddpm"], zh: ["数学", "公式", "证明", "理论"] },
  { icon: "languages", en: ["translat", "i18n", "locali"], zh: ["翻译", "本地化"] },
  { icon: "image", en: ["image", "photo", "picture", "illustrat", "figure", "png", "poster", "svg"], zh: ["图像", "图片", "出图", "配图", "海报", "插画"] },
  { icon: "palette", en: ["design", "style", "theme", "color", "aesthetic", "brand", "ui$", "ux$"], zh: ["设计", "风格", "配色", "美学", "界面", "视觉"] },
  { icon: "clapperboard", en: ["video", "film", "movie", "animation", "manim", "clip$"], zh: ["视频", "剪辑", "动画", "影片"] },
  { icon: "music", en: ["audio", "music", "voice", "speech", "tts", "asr", "transcri", "podcast"], zh: ["语音", "音频", "转写", "配音", "音乐"] },
  { icon: "camera", en: ["screenshot", "capture", "camera"], zh: ["截图", "截屏", "拍照"] },
  { icon: "smartphone", en: ["android", "ios", "mobile", "phone", "emulator", "harmony"], zh: ["安卓", "手机", "模拟器", "鸿蒙"] },
  { icon: "gamepad-2", en: ["game", "godot", "unity", "unreal"], zh: ["游戏"] },
  { icon: "box", en: ["3d", "blender", "mesh", "cad", "model3d"], zh: ["三维", "建模"] },
  { icon: "map", en: ["map", "gis", "geo", "qgis", "spatial", "satellite"], zh: ["地图", "地理", "空间"] },
  { icon: "calendar", en: ["calendar", "schedule", "agenda", "itinerary"], zh: ["日程", "日历", "行程"] },
  { icon: FEATURE_ICON.automation, en: ["automation", "cron", "remind", "timer", "alarm"], zh: ["定时", "提醒", "自动化"] },
  { icon: "mail", en: ["mail", "email", "inbox", "smtp", "imap"], zh: ["邮件", "邮箱"] },
  { icon: "message-square", en: ["chat", "message", "slack", "telegram", "whatsapp", "discord", "feedback"], zh: ["消息", "聊天", "反馈"] },
  { icon: "database", en: ["database", "sql", "postgres", "mysql", "sqlite", "redis", "mongo", "vector"], zh: ["数据库"] },
  { icon: "banknote", en: ["finance", "stock", "invoice", "tax$", "budget", "payment", "accounting"], zh: ["金融", "财务", "税", "股票", "发票", "记账"] },
  { icon: "git-branch", en: ["git", "branch", "commit", "merge", "worktree", "pull-request"], zh: ["分支", "合并", "提交"] },
  { icon: "terminal", en: ["terminal", "shell", "cli$", "bash", "command", "ssh", "zsh"], zh: ["终端", "命令行", "免密"] },
  { icon: "code", en: ["code", "coding", "script", "program", "develop", "debug", "refactor", "typescript", "python", "rust", "compiler"], zh: ["代码", "开发", "编程", "调试", "脚本"] },
  { icon: "globe", en: ["browser", "web", "website", "http", "url", "crawl", "scrape", "playwright", "puppeteer", "wifi", "network"], zh: ["浏览器", "网页", "网站", "爬取", "网络", "联网"] },
  { icon: "search", en: ["search", "query", "lookup", "retriev", "scan"], zh: ["搜索", "检索", "查找", "调研"] },
  { icon: "flask-conical", en: ["experiment", "science", "benchmark", "lab$", "research"], zh: ["实验", "科学", "基准", "研究", "指标"] },
  { icon: "brain", en: ["memory", "recall", "mind"], zh: ["记忆"] },
  { icon: "notebook-pen", en: ["write", "writing", "diary", "journal", "memo", "note", "notes", "draft", "devlog"], zh: ["写作", "日记", "笔记", "备忘", "草稿"] },
  { icon: "file-text", en: ["pdf", "docx", "word$", "document", "doc$", "markdown", "report", "proposal"], zh: ["文档", "报告", "文件"] },
  { icon: FEATURE_ICON.guide, en: ["learn", "tutorial", "teach", "study", "course", "onboarding"], zh: ["学习", "教学", "课程", "引导"] },
  { icon: "shield-check", en: ["security", "audit", "permission", "review", "verify", "accept", "acceptance"], zh: ["安全", "审计", "验收", "审查", "校验"] },
  { icon: "lightbulb", en: ["idea$", "ideas$", "intent", "brainstorm", "insight"], zh: ["意图", "灵感", "想法"] },
  { icon: "workflow", en: ["workflow", "pipeline", "orchestrat", "roadmap"], zh: ["工作流", "流程", "路线图", "编排"] },
  { icon: "key", en: ["password", "token", "auth$", "authenticat", "login", "secret", "oauth"], zh: ["密码", "登录", "密钥", "授权"] },
  { icon: "cpu", en: ["gpu", "server", "compute", "hardware", "linux"], zh: ["服务器", "算力", "硬件"] },
  { icon: "wrench", en: ["tool", "utility", "fix$", "fixes$", "install", "setup", "config", "creator", "kit"], zh: ["工具", "配置", "安装", "修复"] },
  { icon: "bot", en: ["agent", "assistant", "bot"], zh: ["智能体", "助手"] },
];

/** 这一行关键词在文本里**最靠前**的命中位置（没命中为 Infinity）：名字的主体在前、括号里的补充在后，靠前的词更像它是什么。 */
function firstHit(entry: (typeof ICON_KEYWORDS)[number], lower: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const word of entry.zh) {
    const at = lower.indexOf(word);
    if (at >= 0 && at < best) best = at;
  }
  for (const word of entry.en) {
    // 词尾带 $ = 整词相等（cli / doc / ui 这类短词做前缀会误伤 client / docker / uint8）；其余是词前缀
    const exact = word.endsWith("$");
    const stem = exact ? word.slice(0, -1) : word;
    const match = new RegExp(`(?:^|[^a-z0-9])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${exact ? "(?![a-z0-9])" : ""}`).exec(lower);
    if (match !== null) {
      const at = match.index + (match[0].length - stem.length);
      if (at < best) best = at;
    }
  }
  return best;
}

/** 在一段文本里挑最靠前命中的那一行；并列取表里靠前的。 */
function pickKeyword(text: string): IconName | undefined {
  const lower = text.toLowerCase();
  let best: { icon: IconName; at: number } | undefined;
  for (const entry of ICON_KEYWORDS) {
    const at = firstHit(entry, lower);
    if (Number.isFinite(at) && (best === undefined || at < best.at)) best = { icon: entry.icon, at };
  }
  return best?.icon;
}

/** 去掉名字里的括号补充（「ORBITA：PR 验收（真实例 + 对照）」只看前半）。 */
function mainPart(name: string): string {
  return name.replace(/[（(][^）)]*[）)]/g, " ");
}

/** 名字主体优先，其次整个名字（含括号里的补充），最后描述（长，只当第二线索）。认不出为 undefined。 */
export function keywordIcon(name: string, description: string): IconName | undefined {
  return pickKeyword(mainPart(name)) ?? pickKeyword(name) ?? pickKeyword(description);
}

/** 没有任何线索时按种类给一枚中性的。 */
export function kindFallbackIcon(origin: PluginOrigin): IconName {
  return origin === "user-skill" ? "scroll-text" : origin === "user-mcp" ? "plug" : FEATURE_ICON.plugins;
}

// ───────────────────────────── 淡底色 ─────────────────────────────

/** 按名字稳定取色：同一个名字（忽略大小写与首尾空白）永远同一档。djb2 哈希，不依赖列表顺序。 */
export function toneOf(name: string): IconTone {
  let hash = 5381;
  for (const char of name.trim().toLowerCase()) hash = ((hash << 5) + hash + (char.codePointAt(0) ?? 0)) >>> 0;
  return ICON_TONES[hash % ICON_TONES.length] ?? "neutral";
}

/** 取这个能力的图标。 */
export function abilityIconOf(identity: AbilityIdentity): AbilityIconSpec {
  const connector = connectorOf(identity);
  if (connector !== undefined) return { kind: "connector", entry: connector };
  const vendor = vendorOf(identity);
  if (vendor !== undefined) return { kind: "vendor", vendor };
  const icon = keywordIcon(`${identity.name} ${identity.key}`, identity.description) ?? kindFallbackIcon(identity.origin);
  return { kind: "lucide", icon, tone: toneOf(identity.key !== "" ? identity.key : identity.name) };
}
