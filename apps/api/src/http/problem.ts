/** RFC 9457 problem details. Every error the API returns has a stable code. */
export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new Problem(404, "NOT_FOUND", `${what} was not found`);
export const forbidden = (code: string, msg: string) => new Problem(403, code, msg);
export const conflict = (code: string, msg: string, extra?: Record<string, unknown>) => new Problem(409, code, msg, extra);
export const invalid = (msg: string, extra?: Record<string, unknown>) => new Problem(400, "INVALID_REQUEST", msg, extra);

/** Sandbox and platform error codes as HTTP statuses. */
export const STATUS_OF: Record<string, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_HANDLER: 404,
  CAPABILITY_NOT_DECLARED: 403,
  FORBIDDEN_FOR_VIEWER: 403,
  CONFIRMATION_REQUIRED: 409,
  BUDGET_EXHAUSTED: 429,
  RATE_LIMITED: 429,
  SANDBOX_TIMEOUT: 422,
  SANDBOX_MEMORY: 422,
  SANDBOX_LIMIT: 422,
  APP_ERROR: 422,
  UPSTREAM_ERROR: 502,
};
