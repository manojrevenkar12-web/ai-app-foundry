/**
 * What the platform offers apps: connectors (with the data they expose and who may see it) and
 * model aliases. Apps never name a provider or a key; the platform decides which model an alias
 * means and what it costs.
 */
import { z } from "zod";
import { Classification } from "./manifest.js";

export const ConnectorDef = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    access: z.enum(["read", "write"]),
    classification: Classification,
    /** Entra groups (by display name in this repository) whose members may receive this data */
    allowedGroups: z.array(z.string()).min(1),
    /** writes leave the platform's boundary (another system, a message to people) */
    external: z.boolean().default(false),
    args: z.record(z.string(), z.unknown()),
    returns: z.string(),
    /** what the gate's simulated platform returns when an app's tests call this connector */
    example: z.unknown().optional(),
  })
  .strict();
export type ConnectorDef = z.infer<typeof ConnectorDef>;

export const ModelAliasDef = z
  .object({
    alias: z.enum(["fast", "smart", "embed"]),
    provider: z.enum(["sim", "anthropic", "azure-openai"]),
    model: z.string(),
    eurPerMillionIn: z.number().nonnegative(),
    eurPerMillionOut: z.number().nonnegative(),
  })
  .strict();
export type ModelAliasDef = z.infer<typeof ModelAliasDef>;

/** Error codes an app or its caller can see. Stable: tests and UIs match on them. */
export const ErrorCode = z.enum([
  "INVALID_INPUT",
  "UNKNOWN_HANDLER",
  "CAPABILITY_NOT_DECLARED",
  "FORBIDDEN_FOR_VIEWER",
  "BUDGET_EXHAUSTED",
  "RATE_LIMITED",
  "SANDBOX_TIMEOUT",
  "SANDBOX_MEMORY",
  "SANDBOX_LIMIT",
  "APP_ERROR",
  "CONFIRMATION_REQUIRED",
  "UPSTREAM_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
