/**
 * Stdio session against the Mailfact dev API.
 *
 * GitHub Actions logs for this public repo are public. Failures name the
 * tool and the HTTP status. They do not print tokens or API bodies.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { asRecord, resultRows } from "../dist/api.js";
import { RESULT_CAP, capPage, pickFields, shapeValue } from "../dist/shape.js";
import { DEV_API_ORIGIN, devApiOrigin } from "./dev-target.ts";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DOMAIN_FIELDS = [
  "id",
  "fqdn",
  "is_verified",
  "verified_at",
  "dmarc_policy",
  "dmarc_pct",
  "dmarc_rua_tag",
] as const;

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

function tokenFrom(raw: string | undefined): string {
  const token = raw?.trim();
  if (!token) {
    throw new Error("MAILFACT_API_TOKEN is required");
  }
  return token;
}

function match(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the dev API`);
  }
}

function toolPayload(result: ToolResult): unknown {
  const block = result.content.find((item) => item.type === "text");
  if (!block?.text) {
    throw new Error("tool result had no text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text) as unknown;
  } catch {
    throw new Error("tool result was not JSON");
  }
  if (result.isError) {
    const error =
      parsed !== null && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
    const code = typeof error?.code === "string" ? error.code : "tool_failed";
    const message = typeof error?.message === "string" ? error.message.slice(0, 200) : "tool failed";
    throw new Error(`tool failed: ${code}: ${message}`);
  }
  return parsed;
}

function pageView(value: unknown): unknown {
  const record = asRecord(value);
  const { next_cursor: _cursor, ...rest } = record;
  return rest;
}

async function apiGet(token: string, path: string, query: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`/api/v1${path}`, DEV_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`dev API returned ${response.status} for ${path}`);
  }
  return response.json() as Promise<unknown>;
}

test("stdio client matches the Mailfact dev API", { timeout: 60_000 }, async () => {
  const apiUrl = devApiOrigin(process.env.MAILFACT_API_URL);
  const token = tokenFrom(process.env.MAILFACT_API_TOKEN);
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: serverRoot,
    env: {
      MAILFACT_API_URL: apiUrl,
      MAILFACT_API_TOKEN: token,
    },
  });
  const client = new Client({ name: "mailfact-mcp-e2e-live", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "get_alignment_summary",
      "get_domain",
      "get_report_records",
      "get_reporter_coverage",
      "list_aggregate_reports",
      "list_domains",
      "list_sending_sources",
      "query_records",
      "whoami",
    ]);

    const me = await apiGet(token, "/me/");
    const entitlement = await apiGet(token, "/billing/entitlement/resolved/");
    match(
      "whoami",
      toolPayload(await client.callTool({ name: "whoami", arguments: {} })),
      { me: shapeValue(me), entitlement },
    );

    const domainBody = await apiGet(token, "/domains/", { page_size: String(RESULT_CAP) });
    const { rows, nextCursor } = resultRows(domainBody);
    const domains = capPage(
      rows.map((row) => pickFields(row, DOMAIN_FIELDS)),
      nextCursor,
    );
    match(
      "list_domains",
      pageView(toolPayload(await client.callTool({ name: "list_domains", arguments: {} }))),
      pageView(domains),
    );
    const first = domains.results[0];
    const domainId =
      first !== null && typeof first === "object" && typeof (first as { id?: unknown }).id === "string"
        ? (first as { id: string }).id
        : "";
    if (!domainId) {
      throw new Error("dev organisation has no domains");
    }

    match(
      "get_domain",
      toolPayload(await client.callTool({ name: "get_domain", arguments: { id: domainId } })),
      shapeValue(pickFields(asRecord(await apiGet(token, `/domains/${encodeURIComponent(domainId)}/`)), DOMAIN_FIELDS)),
    );

    const summary = asRecord(
      await apiGet(token, "/reports/records/summary/", { domain: domainId, group_by: "source_ip" }),
    );
    if (!Array.isArray(summary.results)) {
      throw new Error("dev API summary had no results");
    }
    match(
      "list_sending_sources",
      pageView(
        toolPayload(
          await client.callTool({ name: "list_sending_sources", arguments: { domain: domainId } }),
        ),
      ),
      pageView({ ...capPage(summary.results, null, "head"), group_by: "source_ip" }),
    );
  } finally {
    await client.close();
  }
});
