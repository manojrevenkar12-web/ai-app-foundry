import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const IdentityFile = z.object({
  tenantId: z.string().uuid(),
  audience: z.string(),
  roles: z.record(z.string(), z.string()),
  groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), countries: z.array(z.string()).optional() })),
  failClosed: z.boolean(),
});
export type Directory = z.infer<typeof IdentityFile> & { byId: Map<string, { name: string; countries: string[] }> };

export const loadDirectory = (file: string): Directory => {
  const d = IdentityFile.parse(parse(readFileSync(file, "utf8")));
  return { ...d, byId: new Map(d.groups.map((g) => [g.id.toLowerCase(), { name: g.name, countries: g.countries ?? [] }])) };
};

/** Group object ids to the configured names and the countries they grant. Unknown groups are ignored. */
export const resolveGroups = (dir: Directory, ids: string[]) => {
  const names: string[] = [];
  const countries = new Set<string>();
  for (const id of ids) {
    const g = dir.byId.get(id.toLowerCase());
    if (!g) continue;
    names.push(g.name);
    for (const c of g.countries) countries.add(c);
  }
  return { names: [...new Set(names)].sort(), countries: countries.has("*") ? ["*"] : [...countries].sort() };
};
