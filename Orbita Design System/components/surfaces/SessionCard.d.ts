export interface SessionCardProps {
  /** Session name, single line, truncated. */
  name: string;
  /** Up to three most recent user queries; always renders three slots so cards stay equal height. */
  queries?: string[];
  /** Shows the accent dot when an agent is running in this session. */
  running?: boolean;
  /** Skeleton state while the queries load. */
  loading?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
