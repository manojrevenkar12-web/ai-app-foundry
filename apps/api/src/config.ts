/** Settings from the environment, validated once at start-up. Business rules live in config/*.yaml. */
import { z } from "zod";

const Schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    /** the API's runtime role: not the owner of the tables, so row-level security applies */
    DATABASE_URL: z.string().default("postgres://foundry_app:foundry_app@127.0.0.1:5432/foundry"),
    /** the owner role, used only to migrate */
    MIGRATION_DATABASE_URL: z.string().default("postgres://foundry:foundry@127.0.0.1:5432/foundry"),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    CONFIG_DIR: z.string().default("../../config"),
    PUBLIC_URL: z.string().url().default("http://127.0.0.1:8080"),
    CONSOLE_URL: z.string().url().default("http://127.0.0.1:5173"),
    /** Entra ID: tenant, the API's application (client) id, and the confidential client for sign-in */
    ENTRA_TENANT_ID: z.string().default("6f1c4f6e-3b0a-4d8e-9a5c-0e2d7f1b8c11"),
    ENTRA_CLIENT_ID: z.string().default("a3d9b2c4-7e1f-4b6a-8c2d-5f9e0a1b3c4d"),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    /** where the identity provider lives: Entra in production, the built-in mock in development */
    ENTRA_AUTHORITY: z.string().url().optional(),
    DEV_IDP: z
      .enum(["on", "off"])
      .default("off")
      .transform((v) => v === "on"),
    /** signs session ids and confirmation tokens */
    SESSION_SECRET: z.string().min(32).optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    FAULT_MODEL_URL: z.string().url().default("http://127.0.0.1:8090"),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((c, ctx) => {
    if (!c.SESSION_SECRET)
      ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "set SESSION_SECRET (32+ characters); there is no default" });
    if (c.NODE_ENV === "production" && c.DEV_IDP)
      ctx.addIssue({ code: "custom", path: ["DEV_IDP"], message: "the mock identity provider cannot run in production" });
    if (c.NODE_ENV === "production" && !c.ENTRA_CLIENT_SECRET)
      ctx.addIssue({
        code: "custom",
        path: ["ENTRA_CLIENT_SECRET"],
        message: "production signs in through Entra ID; set the client secret",
      });
  });

export type Config = z.infer<typeof Schema> & { SESSION_SECRET: string };
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Schema.parse(env) as Config;
