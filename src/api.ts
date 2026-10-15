import type { Config } from "./config.js";
import { cursorFromNext } from "./shape.js";

export class MailfactApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "MailfactApiError";
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export class MailfactClient {
  constructor(private readonly config: Config) {}

  async get(path: string, query: Query = {}): Promise<unknown> {
    const url = new URL(`/api/v1${path}`, this.config.apiOrigin);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Token ${this.config.token}`,
        Accept: "application/json",
        "User-Agent": this.config.userAgent,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw await errorFrom(response);
    }
    return response.json() as Promise<unknown>;
  }
}

export function apiErrorFromEnvelope(
  status: number,
  statusText: string,
  body: unknown,
): MailfactApiError {
  let code = "http_error";
  let message = statusText || "request failed";
  let details: unknown = null;
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = error.message;
    if (error && "details" in error) details = error.details ?? null;
  }
  return new MailfactApiError(status, code, message, details);
}

async function errorFrom(response: Response): Promise<MailfactApiError> {
  try {
    return apiErrorFromEnvelope(response.status, response.statusText, await response.json());
  } catch {
    return apiErrorFromEnvelope(response.status, response.statusText, null);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new MailfactApiError(500, "bad_response", "API response was not an object");
}

export function resultRows(body: unknown): { rows: unknown[]; nextCursor: string | null } {
  const record = asRecord(body);
  const rows = record.results;
  if (!Array.isArray(rows)) {
    throw new MailfactApiError(500, "bad_response", "API response had no results array");
  }
  return { rows, nextCursor: cursorFromNext(record.next) };
}
