/**
 * What an app handler receives. Handlers are named exports:
 *
 *   export async function snapshot(input: Input, ctx: Ctx): Promise<unknown>
 *
 * The handler runs in a sandbox without network, file system, timers or modules. ctx is the only
 * way to reach data, models or other systems, and it offers only what the app's manifest declares.
 * The platform performs every ctx call as the person using the app.
 */
export interface Ctx {
  /** the app's id and live version number */
  readonly app: string;
  readonly version: number;
  /** who is using the app: display facts only; data access is enforced by the platform */
  readonly user: { readonly name: string; readonly roles: readonly string[]; readonly groups: readonly string[] };
  /** the time the invocation started, ISO 8601 */
  now(): string;
  /** appears in the app's preview logs; at most 100 lines per invocation */
  log(...parts: unknown[]): void;

  llm: {
    /**
     * Ask a model. `model` is a declared alias. With `tools` (declared read connectors), the platform
     * runs the tool calls the model makes, as the viewer, and returns the final answer.
     */
    chat(
      req: ChatRequest & { tools?: string[] },
    ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; toolCalls: Array<{ tool: string; ok: boolean }> }>;
    /** Stream an answer to the viewer: return the result of this call from a handler declared with streams: true. */
    stream(req: ChatRequest): Promise<StreamMarker>;
  };

  connectors: {
    /** Call a declared read connector. Writes go through ctx.confirm. */
    call<T = unknown>(id: string, args?: Record<string, unknown>): Promise<T>;
  };

  store: {
    get<T = unknown>(collection: string, key: string): Promise<T | null>;
    put(collection: string, key: string, value: unknown): Promise<null>;
    list<T = unknown>(collection: string, opts?: { prefix?: string; limit?: number }): Promise<Array<{ key: string; value: T }>>;
    delete(collection: string, key: string): Promise<null>;
  };

  /**
   * Ask the viewer to confirm a write (a declared write connector). Return the result from the
   * handler; the platform shows the summary and performs the write only if the viewer confirms.
   */
  confirm(req: { connector: string; args: Record<string, unknown>; summary: string }): ConfirmMarker;
}

export interface ChatRequest {
  model: "fast" | "smart" | "embed";
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** at most the manifest's maxTokensPerCall */
  maxTokens?: number;
  /** 0 (default, cacheable) to 1 */
  temperature?: number;
}

declare const marker: unique symbol;
export interface StreamMarker {
  readonly [marker]: "stream";
}
export interface ConfirmMarker {
  readonly [marker]: "confirm";
}

/**
 * Errors from ctx calls carry a code: CAPABILITY_NOT_DECLARED, FORBIDDEN_FOR_VIEWER,
 * BUDGET_EXHAUSTED, CONFIRMATION_REQUIRED, INVALID_INPUT, UPSTREAM_ERROR, SANDBOX_LIMIT.
 * A handler may catch them; uncaught, they reach the caller unchanged.
 */
export interface PlatformError extends Error {
  readonly code: string;
}
