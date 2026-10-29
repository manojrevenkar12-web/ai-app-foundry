/** The API client. Same origin, session cookie; changes carry x-foundry-request (the API refuses them otherwise). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const parse = async (res: Response) => {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { title: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status, String(body.code ?? "HTTP_ERROR"), String(body.title ?? res.statusText), body);
  return body;
};

export const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-foundry-request": "1" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await parse(res)) as T;
};

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export type InvokeResult =
  | { kind: "value"; value: unknown; usage: Usage; ms: number }
  | { kind: "confirm"; confirmation: Confirmation; usage: Usage }
  | { kind: "stream"; stream: AsyncGenerator<string> };
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costMicroEur: number;
  cacheHits: number;
}
export interface Confirmation {
  id: string;
  summary: string;
  connector: string;
  title: string;
  args: Record<string, unknown>;
  expiresAt: string;
}

/** Server-Sent Events from a fetch body: yields text deltas until the done event. */
async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? "{}";
      const d = JSON.parse(data) as { text?: string; code?: string; message?: string };
      if (event === "text" && d.text) yield d.text;
      if (event === "error") throw new ApiError(502, d.code ?? "UPSTREAM_ERROR", d.message ?? "the answer stopped");
      if (event === "done") return;
      i = buf.indexOf("\n\n");
    }
  }
}

/** Run a handler: a value, a confirmation the viewer must answer, or a streamed answer. */
export const invoke = async (path: string, body: unknown): Promise<InvokeResult> => {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-foundry-request": "1", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) return { kind: "stream", stream: sse(res) };
  const b = await parse(res);
  if (res.status === 202) return { kind: "confirm", confirmation: b.confirmation as Confirmation, usage: b.usage as Usage };
  return { kind: "value", value: b.value, usage: b.usage as Usage, ms: b.ms as number };
};
