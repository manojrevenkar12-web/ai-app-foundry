/** The platform API as the token's owner. Every call is checked and audited by the platform itself. */
export class FoundryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: unknown = undefined,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export const createClient = (o: ClientOptions) => {
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text?: string }> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/json, text/event-stream",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("text/event-stream")) return { status: res.status, body: null, text: collect(await res.text()) };
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* plain text, such as the SDK documents */
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { code?: string; title?: string };
      throw new FoundryError(res.status, p.code ?? "HTTP_ERROR", p.title ?? res.statusText, parsed);
    }
    return { status: res.status, body: parsed };
  };
  return {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown = {}) => call("POST", path, body),
  };
};
export type FoundryClient = ReturnType<typeof createClient>;

/** The text of a streamed answer; an error event becomes an error. */
export const collect = (sse: string) => {
  let out = "";
  for (const chunk of sse.split("\n\n")) {
    const event = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!event || !data) continue;
    const d = JSON.parse(data) as { text?: string; code?: string; message?: string };
    if (event === "text") out += d.text ?? "";
    if (event === "error") throw new FoundryError(502, d.code ?? "UPSTREAM_ERROR", d.message ?? "the stream stopped");
  }
  return out;
};
