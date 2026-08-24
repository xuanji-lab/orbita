export interface IconProps {
  /** Lucide icon file name, e.g. "bot", "arrow-up", "panel-left". */
  name: string;
  /** Pixel box. 12–14 inside chips and rows, 16 in rails and headers. */
  size?: number;
  /** Lucide stroke width. Orbita uses 1.8 in lists and 2 for controls. */
  strokeWidth?: number;
  /** Override the icon directory (defaults to window.ORBITA_ICON_BASE or "assets/icons/lucide"). */
  base?: string;
  style?: React.CSSProperties;
  className?: string;
}
