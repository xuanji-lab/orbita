import { useState } from "react";
import { Icon } from "./Icon";
import { api } from "../api";
import { useT } from "../locale.ts";

/**
 * 窗口标题栏——转帧式窗口后自绘的那一条（right-drawer-X，wafo 2026-09-11 裁决）。
 *
 * **只为 Windows/Linux 渲染**：转帧式（frame:false）后系统不给窗口键，这里自绘
 * 最小化/最大化/关闭。macOS 不渲染本组件——红绿灯是系统的，拖拽区由各顶部行的
 * `.titlebar` 兼任（隐性标题栏）；macOS 上渲染它只会多出一条 38px 空灰条，还弄丢
 * 双击缩放（A-0 复验 BUG-1/BUG-2）。
 *
 * 「复制 transcript」与「抽屉开关」不住这里——它们在右图标条（RightRail，
 * wafo 2026-09-12 裁决）。
 *
 * 整条 `-webkit-app-region: drag`（styles.css 的 .titlebar），按钮逐个 no-drag——
 * 不然点按钮等于拖窗口。
 */
export function Titlebar() {
  const t = useT();
  const [isMaximized, setIsMaximized] = useState(false);

  if (api.platform === "darwin") return null;

  return (
    <div className="titlebar window-titlebar">
      <div className="window-titlebar-actions">
            <button className="titlebar-btn" title={t.titlebar.minimize} onClick={() => void api.window.minimize()}>
              <Icon name="minus" size={14} />
            </button>
            <button
              className="titlebar-btn"
              title={isMaximized ? t.titlebar.restore : t.titlebar.maximize}
              onClick={() => {
                setIsMaximized((maximized) => !maximized);
                void api.window.toggleMaximize();
              }}
            >
              <Icon name={isMaximized ? "copy" : "square"} size={13} />
            </button>
            <button className="titlebar-btn close" title={t.common.close} onClick={() => void api.window.close()}>
              <Icon name="x" size={14} />
            </button>
      </div>
    </div>
  );
}
