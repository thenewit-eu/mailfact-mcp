/** Hard cap on rows returned from one tool call. */
export const RESULT_CAP = 50;

/**
 * Third-party-authored strings that arrive in DMARC XML. They become
 * part of the client model's prompt, so they are length-capped here.
 */
export const STRING_CAP = 120;

const TRUNCATED_KEYS = new Set([
  "reporter_org",
  "header_from",
  "source_ip_as_name",
  "source_ip_name",
  "source_ip_rdns",
  "source_ip_as_domain",
  "envelope_from",
  "reverse_dns",
  "disposition",
  "dkim",
  "spf",
]);

export function shapeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shapeValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && TRUNCATED_KEYS.has(key) && child.length > STRING_CAP) {
        out[key] = child.slice(0, STRING_CAP);
      } else {
        out[key] = shapeValue(child);
      }
    }
    return out;
  }
  return value;
}

export function pickFields(row: unknown, fields: readonly string[]): unknown {
  if (row === null || typeof row !== "object") {
    return row;
  }
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) {
      out[field] = source[field];
    }
  }
  return out;
}

export type CappedList = {
  results: unknown[];
  truncated: boolean;
  next_cursor?: string;
};

/**
 * Keep at most `RESULT_CAP` rows. A following page is named by cursor
 * and is not fetched. If this page itself is longer than the cap, the
 * cursor is omitted: handing it back would skip the rows we cut.
 */
export function capPage(
  rows: unknown[],
  nextCursor: string | null,
  keep: "head" | "tail" = "head",
): CappedList {
  const shaped = rows.map((row) => shapeValue(row));
  if (shaped.length > RESULT_CAP) {
    const results = keep === "tail" ? shaped.slice(-RESULT_CAP) : shaped.slice(0, RESULT_CAP);
    return { results, truncated: true };
  }
  if (nextCursor) {
    return { results: shaped, truncated: true, next_cursor: nextCursor };
  }
  return { results: shaped, truncated: false };
}

type StoredQuery = Record<string, string>;

export function encodePageToken(
  query: Record<string, string | number | boolean | undefined>,
  apiCursor: string,
): string {
  const stored: StoredQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && key !== "cursor" && key !== "page_size") {
      stored[key] = String(value);
    }
  }
  return Buffer.from(JSON.stringify({ c: apiCursor, q: stored }), "utf8").toString("base64url");
}

export function decodePageToken(token: string): { cursor: string; query: StoredQuery } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const body = parsed as { c?: unknown; q?: unknown };
    if (typeof body.c !== "string" || body.q === null || typeof body.q !== "object") return null;
    const query: StoredQuery = {};
    for (const [key, value] of Object.entries(body.q as Record<string, unknown>)) {
      if (typeof value === "string") query[key] = value;
    }
    return { cursor: body.c, query };
  } catch {
    return null;
  }
}

/** A page token continues the query that produced it. Other arguments are ignored. */
export function continueQuery(
  query: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  if (typeof query.cursor !== "string") return query;
  const token = decodePageToken(query.cursor);
  if (!token) return query;
  return { ...token.query, cursor: token.cursor };
}

export function capOffset(rows: unknown[], offset: number): CappedList & { next_offset?: number } {
  const start = Math.max(0, offset);
  const page = capPage(rows.slice(start), null);
  if (!page.truncated) return page;
  return { ...page, next_offset: start + page.results.length };
}

export function cursorFromNext(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0) {
    return null;
  }
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return null;
  }
}
