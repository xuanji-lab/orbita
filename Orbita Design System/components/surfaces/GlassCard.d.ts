export interface GlassCardProps {
  /** 1 = app boundary (most transparent), 2 = chat surface, 3 = input box / session card (near-white). */
  layer?: 1 | 2 | 3;
  /** Element tag to render; use "button" for clickable cards. */
  as?: keyof JSX.IntrinsicElements;
  padding?: string | number;
  /** Override the layer's default corner radius. */
  radius?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}
