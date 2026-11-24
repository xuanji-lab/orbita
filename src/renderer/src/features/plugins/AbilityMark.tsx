/**
 * 厂商标的画法：vendor-logos 里的 SVG（lobe-icons，MIT，许可见该目录 LICENSE）。
 * 彩色标自带品牌色（那是厂商的标，不受「禁裸 hex」约束）；单色标用 currentColor 跟文字色走。
 * 只给 PluginAvatar 用；连接器的标走 connectors/ConnectorLogo.tsx（同一枚标不画两遍）。
 */
import anthropic from "../../../../../design-system/assets/vendor-logos/anthropic.svg?raw";
import capcut from "../../../../../design-system/assets/vendor-logos/capcut.svg?raw";
import claude from "../../../../../design-system/assets/vendor-logos/claude.svg?raw";
import cloudflare from "../../../../../design-system/assets/vendor-logos/cloudflare.svg?raw";
import deepseek from "../../../../../design-system/assets/vendor-logos/deepseek.svg?raw";
import elevenlabs from "../../../../../design-system/assets/vendor-logos/elevenlabs.svg?raw";
import exa from "../../../../../design-system/assets/vendor-logos/exa.svg?raw";
import figma from "../../../../../design-system/assets/vendor-logos/figma.svg?raw";
import firecrawl from "../../../../../design-system/assets/vendor-logos/firecrawl.svg?raw";
import gemini from "../../../../../design-system/assets/vendor-logos/gemini.svg?raw";
import google from "../../../../../design-system/assets/vendor-logos/google.svg?raw";
import huggingface from "../../../../../design-system/assets/vendor-logos/huggingface.svg?raw";
import kimi from "../../../../../design-system/assets/vendor-logos/kimi.svg?raw";
import microsoft from "../../../../../design-system/assets/vendor-logos/microsoft.svg?raw";
import minimax from "../../../../../design-system/assets/vendor-logos/minimax.svg?raw";
import obsidian from "../../../../../design-system/assets/vendor-logos/obsidian.svg?raw";
import openai from "../../../../../design-system/assets/vendor-logos/openai.svg?raw";
import perplexity from "../../../../../design-system/assets/vendor-logos/perplexity.svg?raw";
import qwen from "../../../../../design-system/assets/vendor-logos/qwen.svg?raw";
import tavily from "../../../../../design-system/assets/vendor-logos/tavily.svg?raw";
import vercel from "../../../../../design-system/assets/vendor-logos/vercel.svg?raw";
import zhipu from "../../../../../design-system/assets/vendor-logos/zhipu.svg?raw";
import { iconMarkup } from "../../shell/icon-markup.ts";
import type { VendorKey } from "./ability-icon.ts";

/** 键与 ability-icon.ts 的 VENDORS 一一对应，类型保证一枚都不缺。 */
const VENDOR_SVG: Record<VendorKey, string> = {
  anthropic,
  capcut,
  claude,
  cloudflare,
  deepseek,
  elevenlabs,
  exa,
  figma,
  firecrawl,
  gemini,
  google,
  huggingface,
  kimi,
  microsoft,
  minimax,
  obsidian,
  openai,
  perplexity,
  qwen,
  tavily,
  vercel,
  zhipu,
};

export function VendorMark(props: { vendor: VendorKey }) {
  return <span className="pl-vendor-mark" dangerouslySetInnerHTML={iconMarkup(`vendor:${props.vendor}`, () => VENDOR_SVG[props.vendor].trim())} />;
}
