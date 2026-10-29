import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** An app on disk is four files, the same layout as examples/apps: the coding tool edits them. */
export const FILES = { manifest: "manifest.json", code: "handlers.js", ui: "ui.json", tests: "tests.json" } as const;

export const readBundleDir = (dir: string) => {
  const d = resolve(dir);
  const json = (f: string) => {
    try {
      return JSON.parse(readFileSync(join(d, f), "utf8")) as unknown;
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  };
  return { manifest: json(FILES.manifest), code: readFileSync(join(d, FILES.code), "utf8"), ui: json(FILES.ui), tests: json(FILES.tests) };
};

export const writeBundleDir = (dir: string, b: { manifest: unknown; code: string; ui: unknown; tests: unknown }) => {
  const d = resolve(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, FILES.manifest), `${JSON.stringify(b.manifest, null, 2)}\n`);
  writeFileSync(join(d, FILES.code), b.code.endsWith("\n") ? b.code : `${b.code}\n`);
  writeFileSync(join(d, FILES.ui), `${JSON.stringify(b.ui, null, 2)}\n`);
  writeFileSync(join(d, FILES.tests), `${JSON.stringify(b.tests, null, 2)}\n`);
  return Object.values(FILES).map((f) => join(d, f));
};
