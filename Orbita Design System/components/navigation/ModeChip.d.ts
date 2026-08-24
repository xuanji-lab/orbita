export interface ModeChipProps {
  icon?: React.ReactNode;
  /** Selected mode — blue on the light theme, yellow on the dark theme. */
  active?: boolean;
  /** Not-yet-available modes stay visible but disabled with a tooltip. */
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
