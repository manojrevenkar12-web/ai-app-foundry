import { z } from "zod";
import type { InputSchema } from "./manifest.js";

/** A handler's declared input as a zod schema; the platform validates every input with it. */
export const toZod = (s: InputSchema): z.ZodType => {
  switch (s.type) {
    case "string": {
      if (s.enum?.length) return z.enum(s.enum as [string, ...string[]]);
      return z.string().max(s.maxLength ?? 10_000);
    }
    case "number": {
      let n = z.number().finite();
      if (s.minimum !== undefined) n = n.min(s.minimum);
      if (s.maximum !== undefined) n = n.max(s.maximum);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(toZod(s.items)).max(s.maxItems ?? 100);
    case "object": {
      const req = new Set(s.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(s.properties)) shape[k] = req.has(k) ? toZod(v) : toZod(v).optional();
      return z.object(shape).strict();
    }
  }
};
