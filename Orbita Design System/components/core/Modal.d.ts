export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Renders the header row with the close button when set. */
  title?: string;
  /** full = 1300×850 cap, medium = 800, small = 480. */
  size?: "full" | "medium" | "small";
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
