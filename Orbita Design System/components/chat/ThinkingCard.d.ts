export interface ThinkingCardProps {
  /** Header word; defaults to "thinking". */
  label?: string;
  /** First line of the reasoning, mono, truncated. */
  subtitle?: string;
  /** Elapsed time in the tabular face. */
  duration?: string;
  /** Right-aligned info-blue note, e.g. "streaming". */
  hint?: string;
  /** Full reasoning text, revealed on click. */
  detail?: string;
  defaultOpen?: boolean;
  style?: React.CSSProperties;
}
