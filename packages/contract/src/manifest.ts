/**
 * The app manifest: everything an app may do, declared up front. The publish gate checks the code
 * against it and the runtime exposes nothing outside it, so the manifest is the app's whole
 * capability set, readable by a reviewer in one screen.
 */
import { z } from "zod";

export const Slug = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/, "lowercase letters, digits and dashes, 3 to 40 characters");
export const Classification = z.enum(["public", "internal", "confidential"]);
export type Classification = z.infer<typeof Classification>;
const RANK: Record<Classification, number> = { public: 0, internal: 1, confidential: 2 };
export const classificationRank = (c: Classification) => RANK[c];

/** Who may open the app. Wider audiences raise the review tier. */
export const Audience = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("groups"), groups: z.array(z.string().min(1)).min(1).max(20) }),
  z.object({ kind: z.literal("company") }),
]);
export type Audience = z.infer<typeof Audience>;

/** JSON Schema subset an app may use to describe handler input; the platform validates it. */
export type InputSchema =
  | { type: "string"; maxLength?: number; enum?: string[]; description?: string }
  | { type: "number"; minimum?: number; maximum?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: InputSchema; maxItems?: number; description?: string }
  | { type: "object"; properties: Record<string, InputSchema>; required?: string[]; description?: string };

export const InputSchemaZ: z.ZodType<InputSchema> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("string"),
        maxLength: z.number().int().positive().max(100_000).optional(),
        enum: z.array(z.string()).max(200).optional(),
        description: z.string().max(300).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("number"),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        description: z.string().max(300).optional(),
      })
      .strict(),
    z.object({ type: z.literal("boolean"), description: z.string().max(300).optional() }).strict(),
    z
      .object({
        type: z.literal("array"),
        items: InputSchemaZ,
        maxItems: z.number().int().positive().max(1000).optional(),
        description: z.string().max(300).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), InputSchemaZ),
        required: z.array(z.string()).optional(),
        description: z.string().max(300).optional(),
      })
      .strict(),
  ]),
);

export const Handler = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{1,39}$/, "a camelCase function name"),
    description: z.string().max(300).default(""),
    input: InputSchemaZ,
    /** The handler may return a model stream instead of a value. */
    streams: z.boolean().default(false),
  })
  .strict();
export type Handler = z.infer<typeof Handler>;

export const ModelUse = z
  .object({
    alias: z.enum(["fast", "smart", "embed"]),
    maxTokensPerCall: z.number().int().min(1).max(8192).default(1024),
  })
  .strict();

export const ConnectorUse = z.object({ id: z.string().regex(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/) }).strict();

export const Collection = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{1,39}$/),
    /** private: each viewer sees only their own records; shared: everyone with access to the app */
    scope: z.enum(["private", "shared"]),
    classification: Classification,
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
export type Collection = z.infer<typeof Collection>;

export const Manifest = z
  .object({
    id: Slug,
    name: z.string().min(3).max(60),
    description: z.string().min(10).max(500),
    audience: Audience,
    handlers: z.array(Handler).min(1).max(30),
    models: z.array(ModelUse).max(3).default([]),
    connectors: z.array(ConnectorUse).max(20).default([]),
    collections: z.array(Collection).max(10).default([]),
    budget: z
      .object({
        eurPerDay: z.number().positive().max(500),
        tokensPerUserPerDay: z.number().int().positive().max(2_000_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const dup = (xs: string[]) => xs.find((x, i) => xs.indexOf(x) !== i);
    const h = dup(m.handlers.map((x) => x.name));
    if (h) ctx.addIssue({ code: "custom", path: ["handlers"], message: `handler ${h} is declared twice` });
    const c = dup(m.connectors.map((x) => x.id));
    if (c) ctx.addIssue({ code: "custom", path: ["connectors"], message: `connector ${c} is declared twice` });
    const s = dup(m.collections.map((x) => x.name));
    if (s) ctx.addIssue({ code: "custom", path: ["collections"], message: `collection ${s} is declared twice` });
  });
export type Manifest = z.infer<typeof Manifest>;
