import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MailfactApiError, MailfactClient, asRecord, resultRows } from "./api.js";
import type { Query } from "./api.js";
import { RESULT_CAP, capOffset, capPage, continueQuery, encodePageToken, pickFields, shapeValue } from "./shape.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

const DOMAIN_FIELDS = [
  "id",
  "fqdn",
  "is_verified",
  "verified_at",
  "dmarc_policy",
  "dmarc_pct",
  "dmarc_rua_tag",
] as const;

const RECORD_FIELDS = [
  "day",
  "domain_fqdn",
  "source_ip",
  "source_ip_name",
  "source_ip_as_name",
  "source_ip_asn",
  "source_ip_country",
  "header_from",
  "reporter_org",
  "disposition",
  "dkim_aligned",
  "spf_aligned",
  "count",
] as const;

const AGGREGATE_FIELDS = [
  "id",
  "domain_fqdn",
  "reporter_org",
  "report_id",
  "date_begin",
  "date_end",
  "policy_p",
  "policy_pct",
] as const;

const dayWindow = {
  domain: z.string().describe("Domain id. Omit to include every domain on the token.").optional(),
  day_after: z.string().describe("Inclusive lower bound, YYYY-MM-DD. Default is 30 days ago.").optional(),
  day_before: z.string().describe("Inclusive upper bound, YYYY-MM-DD. Default is today.").optional(),
};

function toolOk(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolErr(err: unknown) {
  const error =
    err instanceof MailfactApiError
      ? { code: err.code, message: err.message, status: err.status, details: err.details }
      : { code: "request_failed", message: err instanceof Error ? err.message : "request failed" };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return toolOk(await fn());
  } catch (err) {
    return toolErr(err);
  }
}

async function summary(
  api: MailfactClient,
  groupBy: string,
  window: Query,
  keep: "head" | "tail",
) {
  const body = asRecord(await api.get("/reports/records/summary/", { ...window, group_by: groupBy }));
  const rows = body.results;
  if (!Array.isArray(rows)) {
    throw new MailfactApiError(500, "bad_response", "summary response had no results array");
  }
  return { ...capPage(rows, null, keep), group_by: groupBy };
}

async function paged(
  api: MailfactClient,
  path: string,
  query: Query,
  fields: readonly string[],
) {
  const effective = continueQuery(query);
  const { rows, nextCursor } = resultRows(
    await api.get(path, { ...effective, page_size: RESULT_CAP }),
  );
  const page = capPage(rows.map((row) => pickFields(row, fields)), nextCursor);
  if (page.next_cursor) {
    page.next_cursor = encodePageToken(effective, page.next_cursor);
  }
  return page;
}

export function registerTools(server: McpServer, api: MailfactClient): void {
  server.registerTool(
    "list_domains",
    {
      title: "List domains",
      description:
        "Domains registered on this token's organisation. Pass fqdn for an exact hostname match (case-insensitive, trailing dot stripped). Returns ids the other tools take as domain.",
      inputSchema: {
        fqdn: z.string().describe("Exact domain name, e.g. mailfact.app.").optional(),
      },
      annotations: readOnly,
    },
    async ({ fqdn }) =>
      run(() => paged(api, "/domains/", { fqdn }, DOMAIN_FIELDS)),
  );

  server.registerTool(
    "get_domain",
    {
      title: "Get domain",
      description: "One domain by id, including its published DMARC policy snapshot and the RUA tag to publish.",
      inputSchema: { id: z.string().describe("Domain id from list_domains.") },
      annotations: readOnly,
    },
    async ({ id }) =>
      run(async () =>
        shapeValue(pickFields(asRecord(await api.get(`/domains/${encodeURIComponent(id)}/`)), DOMAIN_FIELDS)),
      ),
  );

  server.registerTool(
    "get_alignment_summary",
    {
      title: "Alignment by day",
      description:
        "Per-day message counts: total, DMARC pass, DMARC fail, and disposition (none, quarantine, reject). Counts are message-weighted. Default window is 30 days, clamped at 365. If the window has more than 50 days, the most recent 50 are returned and truncated is true. Pass an earlier day_before to see the days before those.",
      inputSchema: dayWindow,
      annotations: readOnly,
    },
    async (args) => run(() => summary(api, "day", args, "tail")),
  );

  server.registerTool(
    "get_reporter_coverage",
    {
      title: "Reporter coverage",
      description:
        "One row per receiving mailbox provider (the DMARC reporter_org), with message-weighted pass/fail counts and sources_seen. Sorted by volume descending. At most 50 rows.",
      inputSchema: dayWindow,
      annotations: readOnly,
    },
    async (args) => run(() => summary(api, "reporter_org", args, "head")),
  );

  server.registerTool(
    "list_sending_sources",
    {
      title: "Sending sources",
      description:
        "One row per sending IP (default), autonomous system, or From domain. Counts are message-weighted, including spf_passed and dkim_passed. Identity strings are the greatest value seen in the window and are length-capped. Sorted by volume descending. At most 50 rows; truncated is true when more existed.",
      inputSchema: {
        ...dayWindow,
        group_by: z
          .enum(["source_ip", "source_ip_asn", "header_from"])
          .describe("Bucket key. Default source_ip.")
          .optional(),
      },
      annotations: readOnly,
    },
    async ({ group_by, ...window }) =>
      run(() => summary(api, group_by ?? "source_ip", window, "head")),
  );

  server.registerTool(
    "query_records",
    {
      title: "Query fact rows",
      description:
        "Day-aggregated fact rows. Use this to drill into one IP, day, or alignment outcome. Does not follow pagination: when truncated is true, pass next_cursor back as cursor. The cursor carries the filters, so the follow-up does not need to restate them. Rows are narrowed and third-party strings are length-capped.",
      inputSchema: {
        domain: z.string().optional(),
        day: z.string().describe("Exact day, YYYY-MM-DD.").optional(),
        day_after: z.string().optional(),
        day_before: z.string().optional(),
        source_ip: z.string().describe("Exact sending IP.").optional(),
        source_ip_country: z.string().describe("ISO 3166-1 alpha-2.").optional(),
        source_ip_asn: z.number().optional(),
        source_ip_as_name: z.string().describe("Substring of the AS name.").optional(),
        source_ip_name: z.string().describe("Substring of the sender label.").optional(),
        header_from: z.string().describe("Substring of the From domain.").optional(),
        reporter_org: z.string().describe("Substring of the reporter name.").optional(),
        disposition: z.enum(["none", "quarantine", "reject"]).optional(),
        dkim_aligned: z.boolean().optional(),
        spf_aligned: z.boolean().optional(),
        cursor: z.string().describe("next_cursor from a previous truncated response.").optional(),
      },
      annotations: readOnly,
    },
    async (args) => run(() => paged(api, "/reports/records/", args, RECORD_FIELDS)),
  );

  server.registerTool(
    "list_aggregate_reports",
    {
      title: "List aggregate reports",
      description:
        "One row per ingested aggregate XML. Use the id with get_report_records. Does not follow pagination: when truncated is true, pass next_cursor back as cursor. The cursor carries the filters.",
      inputSchema: {
        domain: z.string().optional(),
        reporter_org: z.string().describe("Substring of the reporter name.").optional(),
        date_end_after: z.string().describe("ISO-8601 timestamp.").optional(),
        date_end_before: z.string().describe("ISO-8601 timestamp.").optional(),
        cursor: z.string().optional(),
      },
      annotations: readOnly,
    },
    async (args) => run(() => paged(api, "/reports/aggregate/", args, AGGREGATE_FIELDS)),
  );

  server.registerTool(
    "get_report_records",
    {
      title: "Records inside one aggregate report",
      description:
        "Re-parses one aggregate XML into per-record rows (source, count, alignment, disposition, identifiers). Third-party strings are length-capped. At most 50 rows. When truncated is true, pass next_offset back as offset.",
      inputSchema: {
        id: z.string().describe("Aggregate report id."),
        offset: z.number().int().nonnegative().describe("next_offset from a truncated response.").optional(),
      },
      annotations: readOnly,
    },
    async ({ id, offset }) =>
      run(async () => {
        const { rows } = resultRows(
          await api.get(`/reports/aggregate/${encodeURIComponent(id)}/records/`),
        );
        return capOffset(rows, offset ?? 0);
      }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Token identity",
      description:
        "The organisation this token is bound to, and the resolved plan features (api_tokens_enabled, retention_days, and the rest). user is null for an API token.",
      annotations: readOnly,
    },
    async () =>
      run(async () => {
        const me = await api.get("/me/");
        const entitlement = await api.get("/billing/entitlement/resolved/");
        return { me: shapeValue(me), entitlement };
      }),
  );
}
