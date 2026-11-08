import baiduNetdisk from "../../../../../design-system/assets/connector-logos/baidu-netdisk.png";
import ctrip from "../../../../../design-system/assets/connector-logos/ctrip.png";
import dingtalk from "../../../../../design-system/assets/connector-logos/dingtalk.png";
import feishu from "../../../../../design-system/assets/connector-logos/feishu.svg";
import githubMono from "../../../../../design-system/assets/connector-logos/github.svg?raw";
import pangram from "../../../../../design-system/assets/connector-logos/pangram.svg";
import notionMono from "../../../../../design-system/assets/connector-logos/notion.svg?raw";
import supabase from "../../../../../design-system/assets/connector-logos/supabase.svg";
import tabbit from "../../../../../design-system/assets/connector-logos/tabbit.png";
import tencentDocs from "../../../../../design-system/assets/connector-logos/tencent-docs.svg";
import wecom from "../../../../../design-system/assets/connector-logos/wecom.png";
import type { ConnectorEntry } from "@shared/connectors";
import { iconMarkup } from "../../shell/icon-markup.ts";

/**
 * 品牌标（「图标只用 lucide」的用户批准例外，来源与许可见 connector-logos/NOTICE）。
 * 键 = 目录里 `logo.file`；connectors-logo.test.ts 核对目录里每个文件在这里都有一条。
 * 彩色标自带品牌色（那是各家的标，不受「禁裸 hex」约束）；单色标（GitHub / Notion）用 currentColor，
 * 随主题文字色走——暗色下变白，不另做浅色底。
 */
const IMAGES: Record<string, string> = {
  "feishu.svg": feishu,
  "dingtalk.png": dingtalk,
  "wecom.png": wecom,
  "tabbit.png": tabbit,
  "tencent-docs.svg": tencentDocs,
  "ctrip.png": ctrip,
  "baidu-netdisk.png": baiduNetdisk,
  "supabase.svg": supabase,
  "pangram.svg": pangram,
};

const MONO: Record<string, string> = {
  "github.svg": githubMono,
  "notion.svg": notionMono,
};

/** 图块里的标。图块本身（灰底圆角方块）是 `.pl-av`，大小由外层给（big 卡 / row 行）。 */
export function ConnectorLogo(props: { entry: ConnectorEntry; size: "big" | "row" }) {
  const { logo } = props.entry;
  const mono = logo.mono ? MONO[logo.file] : undefined;
  return (
    <span className={`pl-av cn-logo ${props.size === "big" ? "big" : "row"}${logo.mono ? " mono" : ""}`} aria-hidden="true">
      {mono !== undefined ? (
        <span className="cn-logo-mono" dangerouslySetInnerHTML={iconMarkup(`connector:${logo.file}`, () => mono.trim())} />
      ) : (
        <img src={IMAGES[logo.file]} alt="" draggable={false} />
      )}
    </span>
  );
}
