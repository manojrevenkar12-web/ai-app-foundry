/** The UI spec must call handlers that exist with the inputs they declare, and its text must be inert. */
import type { InputSchema, Manifest, UiSpec } from "@foundry/contract";
import { block, type Finding, warn } from "./findings.js";

const COMPATIBLE: Record<string, InputSchema["type"][]> = {
  text: ["string"],
  textarea: ["string"],
  select: ["string"],
  date: ["string"],
  number: ["number"],
  toggle: ["boolean"],
};

/** Markdown in a page is shown to every viewer: no HTML, no images (a beacon to an outside server), no script links. */
export const checkMarkdown = (where: string, text: string): Finding[] => {
  const out: Finding[] = [];
  if (/<\s*[a-z!/]/i.test(text)) out.push(block("ui.html", `${where} contains HTML; use markdown only`, { at: where }));
  if (/!\[[^\]]*\]\([^)]*\)/.test(text))
    out.push(block("ui.image", `${where} embeds an image; images in apps can carry data to outside servers`, { at: where }));
  if (/\]\(\s*(?:javascript|data|vbscript):/i.test(text)) out.push(block("ui.script-link", `${where} has a script link`, { at: where }));
  else if (/\]\(\s*https?:\/\//i.test(text)) out.push(warn("ui.external-link", `${where} links outside the platform`, { at: where }));
  return out;
};

export const checkUi = (m: Manifest, ui: UiSpec): Finding[] => {
  const out: Finding[] = [];
  const handlers = new Map(m.handlers.map((h) => [h.name, h]));
  const used = new Set<string>();
  for (const [pi, page] of ui.pages.entries())
    for (const [bi, b] of page.blocks.entries()) {
      const at = `ui.pages[${pi}].blocks[${bi}]`;
      if (b.type === "markdown") {
        out.push(...checkMarkdown(at, b.text));
        continue;
      }
      const h = handlers.get(b.handler);
      if (!h) {
        out.push(block("ui.unknown-handler", `${at} calls ${b.handler}, which the manifest does not declare`, { at }));
        continue;
      }
      used.add(h.name);
      const input = h.input.type === "object" ? h.input : null;
      if (b.type === "form") {
        if (!input) {
          out.push(block("ui.form-input", `${b.handler} takes a ${h.input.type}; a form needs an object input`, { at }));
          continue;
        }
        for (const f of b.fields) {
          const p = input.properties[f.name];
          if (!p) out.push(block("ui.form-field", `field ${f.name} is not an input of ${b.handler}`, { at }));
          else if (!COMPATIBLE[f.kind]?.includes(p.type))
            out.push(block("ui.form-field", `field ${f.name} is a ${f.kind} but ${b.handler} expects a ${p.type}`, { at }));
        }
        for (const r of input.required ?? [])
          if (!b.fields.some((f) => f.name === r))
            out.push(block("ui.form-field", `${b.handler} requires ${r}, which the form does not ask for`, { at }));
        if (h.streams) out.push(warn("ui.stream", `${b.handler} streams; a form shows its result only when it is complete`, { at }));
      }
      if (b.type === "chat") {
        const msg = input?.properties.message;
        if (msg?.type !== "string")
          out.push(block("ui.chat-input", `a chat handler takes { message: string, history?: [...] }; ${b.handler} does not`, { at }));
        if (b.intro) out.push(...checkMarkdown(`${at}.intro`, b.intro));
      }
      if (b.type === "view" && (input?.required?.length ?? 0) > 0)
        out.push(block("ui.view-input", `${b.handler} requires input, so a view cannot call it on load`, { at }));
    }
  for (const h of m.handlers)
    if (!used.has(h.name))
      out.push(warn("ui.unused-handler", `handler ${h.name} is not reachable from the UI (it can still be called through the API)`));
  return out;
};
