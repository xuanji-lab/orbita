export interface ChipProps {
  /** Leading glyph, usually <Icon size={12} />. */
  icon?: React.ReactNode;
  /** Adds the disclosure caret for chips that open a picker. */
  chevron?: boolean;
  /** Selected state — reads blue on light, yellow on dark. */
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
