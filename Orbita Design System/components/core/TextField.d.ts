export interface TextFieldProps {
  label?: React.ReactNode;
  value: string;
  onChange?: (value: string) => void;
  /** Quiet helper line under the field. */
  description?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  type?: "text" | "number" | "password";
  style?: React.CSSProperties;
}
