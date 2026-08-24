export interface ToolCardProps {
  /** Tool name, rendered lowercase at body size / 650 weight. */
  name: string;
  /** Argument or path, in the mono face, truncated to one line. */
  subtitle?: string;
  /** Lucide icon name from assets/icons/lucide. */
  icon?: string;
  /** running = amber spinner, error = red status, done = quiet. */
  tone?: "done" | "running" | "error";
  /** Short status word, e.g. "12 files" or "failed". */
  status?: string;
  /** Elapsed time in the tabular face, e.g. "2.4s". */
  duration?: string;
  /** Output revealed on click. */
  detail?: string;
  defaultOpen?: boolean;
  style?: React.CSSProperties;
}
