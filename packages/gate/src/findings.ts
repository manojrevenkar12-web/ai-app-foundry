export type Severity = "block" | "warn" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** where: "manifest.connectors[2]", "ui.pages[0].blocks[1]", or a code position */
  at?: string;
  line?: number;
  column?: number;
}

export const block = (rule: string, message: string, at?: Partial<Finding>): Finding => ({ rule, severity: "block", message, ...at });
export const warn = (rule: string, message: string, at?: Partial<Finding>): Finding => ({ rule, severity: "warn", message, ...at });
export const info = (rule: string, message: string, at?: Partial<Finding>): Finding => ({ rule, severity: "info", message, ...at });
