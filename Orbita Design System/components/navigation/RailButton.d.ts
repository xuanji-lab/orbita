export interface RailButtonProps {
  /** Tooltip — the only label a rail button gets. */
  title: string;
  /** Current mode / open panel. */
  active?: boolean;
  /** Planned or unavailable: rendered as a non-interactive span. */
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
