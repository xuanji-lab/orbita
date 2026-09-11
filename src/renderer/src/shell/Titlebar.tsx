import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { api } from "../api";

/**
 * 窗口标题栏——转帧式窗口后自绘的那一条（right-drawer-X，wafo 2026-09-11 裁决）。
 *
 * 只住窗口键：Windows/Linux 画最小化/最大化/关闭三键（frame:false 之后系统不给了）；
 * macOS 的红绿灯是系统的，这里只剩拖拽区。**「复制 transcript」与「抽屉开关」
 * 不住这里**——它们在右图标条（RightRail，wafo 2026-09-12 裁决）。
 *
 * 整条 `-webkit-app-region: drag`（styles.css 的 .titlebar），按钮逐个 no-drag——
 * 不然点按钮等于拖窗口。macOS 上左端让出红绿灯净空，也是 .titlebar 的既有规则。
 */
export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);

  return (
    <div className="titlebar window-titlebar">
      <div className="window-titlebar-actions">
        {api.platform !== "darwin" && (
          <>
            <button className="titlebar-btn" title="最小化" onClick={() => void api.window.minimize()}>
              <Icon name="minus" size={14} />
            </button>
            <button
              className="titlebar-btn"
              title="最大化"
              onClick={() => {
                setIsMaximized((maximized) => !maximized);
                void api.window.toggleMaximize();
              }}
            >
              <Icon name={isMaximized ? "copy" : "square"} size={13} />
            </button>
            <button className="titlebar-btn close" title="关闭" onClick={() => void api.window.close()}>
              <Icon name="x" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
