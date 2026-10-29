import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorDef, ModelAliasDef } from "@foundry/contract";
import { parse } from "yaml";
import { z } from "zod";
import type { Catalog } from "./catalog.js";

/** An app as files: manifest.json, handlers.js, ui.json, tests.json. Not validated here; the gate does that. */
export const loadBundleDir = (dir: string): unknown => ({
  manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
  code: readFileSync(join(dir, "handlers.js"), "utf8"),
  ui: JSON.parse(readFileSync(join(dir, "ui.json"), "utf8")),
  tests: JSON.parse(readFileSync(join(dir, "tests.json"), "utf8")),
});

const CatalogFile = z.object({ models: z.array(ModelAliasDef), connectors: z.array(ConnectorDef) });
export const loadCatalog = (file: string): Catalog => CatalogFile.parse(parse(readFileSync(file, "utf8")));
