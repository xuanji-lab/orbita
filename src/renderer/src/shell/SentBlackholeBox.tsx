import { useLayoutEffect, useRef, useState } from "react";
import { FileChip } from "./composer-material-stack.tsx";
import { ImageLightbox } from "./ImageLightbox";
import { ImageThumb } from "./ImageThumb";
import { imageSrc } from "./composer-images.ts";
import { boxSpan, flyBlackholeInto } from "./BlackholeBox.tsx";
import {
  BLACKHOLE_SENT_SCALE,
  BLACKHOLE_STEP_PX,
  cellsToPx,
  columnsForWidth,
  packedExtent,
  packPlacements,
} from "./blackhole-layout.ts";
import type { PromptImage } from "@shared/prompt-images";
import { useT } from "../locale.ts";

/**
 * 已发送用户消息顶上的缩小盒子（输入框黑洞开启时；只在浅 / 黛 / 玄）。
 *
 * 布局**只凭消息里的附件清单重算**（截图在前、文件 / 目录在后——与输入框里的清单
 * 同序），同一个列数下与输入框里没删过东西时的盒子逐块相同；所以不往会话存储里
 * 写任何布局。列数取消息列的宽（与输入框同一个 --content-max-width），整盒按
 * BLACKHOLE_SENT_SCALE 等比缩成一张快照、贴右（用户消息靠右）。不设行数上限。
 *
 * 交互照旧：截图点开看大图，文件 / 目录胶囊悬停看完整路径；只读，没有移除键。
 * 刚发出的那一条在挂上时接住输入框盒子的飞行（flyBlackholeInto）。
 */
export function SentBlackholeBox(props: {
  images: readonly PromptImage[];
  files: readonly { name: string; path: string; kind: "file" | "dir" }[];
}) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const cells = useRef<(HTMLDivElement | null)[]>([]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const measure = (): void => setWidth(wrap.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const columns = columnsForWidth(width);
  const items = [
    ...props.images.map((image, index) => ({ kind: "image" as const, name: "", image, index })),
    ...props.files.map((file) => ({ kind: file.kind, name: file.name, file })),
  ];
  const placed = packPlacements(
    items.map((item) => boxSpan({ kind: item.kind, name: item.name }, columns)),
    columns,
  );
  const { cols, rows } = packedExtent(placed);
  const innerWidth = cellsToPx(cols);
  const innerHeight = cellsToPx(rows);

  // 第一次量出宽度、块都落位之后，接住刚发送时输入框盒子的飞行（不是刚发的就什么也不做）
  const flown = useRef(false);
  useLayoutEffect(() => {
    if (flown.current || width === 0) return;
    flown.current = true;
    flyBlackholeInto(cells.current.filter((el): el is HTMLDivElement => el !== null));
  }, [width]);

  return (
    <div ref={wrapRef} style={{ width: "100%", display: "flex", justifyContent: "flex-end" }}>
      {viewing !== null && (
        <ImageLightbox images={props.images} startIndex={viewing} onClose={() => setViewing(null)} />
      )}
      {width > 0 && (
        <div
          className="bh-sent"
          style={{ width: innerWidth * BLACKHOLE_SENT_SCALE, height: innerHeight * BLACKHOLE_SENT_SCALE }}
        >
          <div
            className="bh-sent-inner"
            style={{ width: innerWidth, height: innerHeight, transform: `scale(${BLACKHOLE_SENT_SCALE})` }}
          >
            {items.map((item, index) => {
              const p = placed[index];
              if (p === undefined) return null;
              return (
                <div
                  key={item.kind === "image" ? `image:${item.index}` : `file:${index}`}
                  ref={(el) => {
                    cells.current[index] = el;
                  }}
                  className="bh-cell"
                  style={{
                    left: p.x * BLACKHOLE_STEP_PX,
                    bottom: p.y * BLACKHOLE_STEP_PX,
                    width: cellsToPx(p.w),
                    height: cellsToPx(p.h),
                  }}
                >
                  {item.kind === "image" ? (
                    <ImageThumb
                      src={imageSrc(item.image)}
                      name=""
                      size={cellsToPx(p.w)}
                      openLabel={t.lightbox.open}
                      onOpen={() => setViewing(item.index)}
                      paperclip
                    />
                  ) : (
                    <FileChip name={item.file.name} path={item.file.path} kind={item.file.kind} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
