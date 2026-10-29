import { createHash } from "node:crypto";
import { z } from "zod";
import { Manifest } from "./manifest.js";
import { UiSpec } from "./ui.js";

/** An example run the gate executes in the sandbox before publishing. */
export const AppTest = z
  .object({
    name: z.string().min(3).max(120),
    handler: z.string(),
    input: z.unknown(),
    expect: z
      .object({
        /** substrings the JSON of the result must contain */
        contains: z.array(z.string().max(200)).max(10).default([]),
        /** the handler must fail with this platform error code */
        errorCode: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type AppTest = z.infer<typeof AppTest>;

export const MAX_CODE_BYTES = 200_000;

export const Bundle = z
  .object({
    manifest: Manifest,
    code: z.string().min(1).max(MAX_CODE_BYTES),
    ui: UiSpec,
    tests: z.array(AppTest).max(50).default([]),
  })
  .strict();
export type Bundle = z.infer<typeof Bundle>;

/** Canonical JSON (sorted keys) so the same bundle always hashes the same. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
};

/** Approvals are bound to this hash: a changed bundle is a different bundle. */
export const bundleHash = (b: Bundle) => createHash("sha256").update(canonical(b)).digest("hex");
