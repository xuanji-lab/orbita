export interface SessionRowProps {
  /** Session title — first user input, truncated to one line. */
  title: string;
  /** Last-active time in the tabular face, e.g. "14:22" or "Aug 21". */
  time?: string;
  /** Currently open in the chat pane. */
  active?: boolean;
  /** An agent is running in this session — wins over `status`. */
  running?: boolean;
  /** Leading status glyph. Idle shows an empty slot, keeping titles aligned. */
  status?: "running" | "done" | "failed" | "idle";
  readOnly?: boolean;
  onClick?: () => void;
  onToggleReadOnly?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}
