import { useRef, useState } from "react";
import type { TableElement } from "../../../../shared/slides.ts";
import { useT } from "../../locale.ts";

/**
 * 表格的就地编辑：在表格的位置铺一个输入网格（每格一个 input），Tab / 方向键走格，
 * 失焦（焦点离开整个网格）或 Esc 提交。加减行列用底部两行小按钮。
 */
export function TableEditor(props: { element: TableElement; scale: number; onDone: (rows: string[][] | null) => void }) {
  const t = useT();
  const { element } = props;
  const [rows, setRows] = useState<string[][]>(() => element.rows.map((row) => [...row]));
  const hostRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const finish = (save: boolean): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    const changed = JSON.stringify(rows) !== JSON.stringify(element.rows);
    props.onDone(save && changed ? rows : null);
  };
  const cols = rows[0]?.length ?? 0;
  const setCell = (r: number, c: number, value: string): void =>
    setRows((current) => current.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)));
  const move = (r: number, c: number): void => {
    hostRef.current?.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`)?.focus();
  };
  return (
    <div
      ref={hostRef}
      className="se-table-editor"
      data-editing="true"
      // 画布里的元素是按缩放比放大 / 缩小的；编辑器的界面不该跟着变：宽度换算成屏幕像素再反向缩回来
      style={{ left: element.x, top: element.y, width: element.w * props.scale, transform: `scale(${1 / props.scale})` }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) finish(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(true);
        }
      }}
    >
      <div className="se-table-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {rows.map((row, r) =>
          row.map((cell, c) => (
            <input
              key={`${r}-${c}`}
              data-r={r}
              data-c={c}
              data-head={element.header && r === 0 ? "true" : undefined}
              className="se-table-cell"
              value={cell}
              autoFocus={r === 0 && c === 0}
              onChange={(event) => setCell(r, c, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  move(Math.min(r + 1, rows.length - 1), c);
                } else if (event.key === "ArrowDown" && r < rows.length - 1) move(r + 1, c);
                else if (event.key === "ArrowUp" && r > 0) move(r - 1, c);
              }}
            />
          )),
        )}
      </div>
      <div className="se-table-actions">
        <button type="button" className="dp-text-action" onClick={() => setRows((cur) => [...cur, Array.from({ length: cols }, () => "")])}>
          {t.slides.addRow}
        </button>
        <button type="button" className="dp-text-action" disabled={rows.length <= 1} onClick={() => setRows((cur) => cur.slice(0, -1))}>
          {t.slides.removeRow}
        </button>
        <button type="button" className="dp-text-action" onClick={() => setRows((cur) => cur.map((row) => [...row, ""]))}>
          {t.slides.addColumn}
        </button>
        <button type="button" className="dp-text-action" disabled={cols <= 1} onClick={() => setRows((cur) => cur.map((row) => row.slice(0, -1)))}>
          {t.slides.removeColumn}
        </button>
        <span className="dp-bar-grow" />
        <button type="button" className="dp-text-action" onClick={() => finish(true)}>
          {t.slides.done}
        </button>
      </div>
    </div>
  );
}
