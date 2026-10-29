/**
 * The UI an app ships is data, not code: blocks from the platform's design system. The console
 * renders them, so a generated app cannot run script in a colleague's browser and every app looks
 * and behaves like the rest of the platform.
 */
import { z } from "zod";

const Name = z.string().regex(/^[a-z][a-zA-Z0-9]{1,39}$/);
const Label = z.string().min(1).max(80);
/** A dotted path into the handler's result, e.g. "rows" or "summary.total". */
const Path = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/)
  .max(120);

export const Field = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
    label: Label,
    kind: z.enum(["text", "textarea", "number", "select", "date", "toggle"]),
    options: z
      .array(z.object({ value: z.string().max(100), label: Label }).strict())
      .max(100)
      .optional(),
    required: z.boolean().default(false),
    help: z.string().max(200).optional(),
  })
  .strict();

export const Column = z
  .object({ key: Path, label: Label, format: z.enum(["text", "number", "eur", "percent", "datetime", "status"]).default("text") })
  .strict();

const ResultView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), path: Path }).strict(),
  z.object({ type: z.literal("table"), path: Path, columns: z.array(Column).min(1).max(12) }).strict(),
  z
    .object({
      type: z.literal("stats"),
      items: z
        .array(z.object({ path: Path, label: Label, format: Column.shape.format }).strict())
        .min(1)
        .max(6),
    })
    .strict(),
  z
    .object({
      type: z.literal("chart"),
      path: Path,
      kind: z.enum(["line", "bar"]),
      x: z.string().max(40),
      y: z.array(z.string().max(40)).min(1).max(4),
      yLabel: Label.optional(),
    })
    .strict(),
]);
export type ResultView = z.infer<typeof ResultView>;

export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), text: z.string().max(4000) }).strict(),
  z
    .object({
      type: z.literal("form"),
      handler: Name,
      title: Label.optional(),
      fields: z.array(Field).min(1).max(20),
      submitLabel: Label,
      result: z.array(ResultView).min(1).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat"),
      handler: Name,
      intro: z.string().max(400).optional(),
      placeholder: z.string().max(120).optional(),
      suggestions: z.array(z.string().max(120)).max(4).default([]),
    })
    .strict(),
  z.object({ type: z.literal("view"), handler: Name, title: Label.optional(), result: z.array(ResultView).min(1).max(4) }).strict(),
]);
export type Block = z.infer<typeof Block>;

export const UiSpec = z
  .object({
    pages: z
      .array(z.object({ id: Name, title: Label, blocks: z.array(Block).min(1).max(12) }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export type UiSpec = z.infer<typeof UiSpec>;
