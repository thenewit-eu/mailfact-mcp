/**
 * One stdio session against a live docker-compose backend.
 *
 * Builds the `web` image (it bakes the tree), ingests a real Google
 * aggregate fixture, then calls tools through the MCP client SDK.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const backend = path.resolve(serverRoot, "../dmarc-reporting");

type Seed = {
  token: string;
  domain_id: string;
  fqdn: string;
  day_after: string;
  day_before: string;
  source_ip: string;
  total: number;
  org_slug: string;
};

function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: backend,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 600_000,
  });
}

function waitForHealth(): void {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      execFileSync("curl", ["-fsS", "http://localhost:8000/healthz"], { stdio: "pipe" });
      return;
    } catch {
      execFileSync("sleep", ["1"]);
    }
  }
  throw new Error("web did not answer /healthz on localhost:8000");
}

function seedBackend(): Seed {
  compose(["up", "-d", "--build", "web"]);
  waitForHealth();
  const script = execFileSync("python3", ["-c", "print(open('test/seed.py').read())"], {
    cwd: serverRoot,
    encoding: "utf8",
  });
  const output = compose(["exec", "-T", "web", "python", "manage.py", "shell", "-c", script]);
  const line = output.split("\n").find((row) => row.startsWith("MCP_E2E_JSON "));
  if (!line) {
    throw new Error(`seed produced no MCP_E2E_JSON line:\n${output}`);
  }
  return JSON.parse(line.slice("MCP_E2E_JSON ".length)) as Seed;
}

function textOf(result: { content: { type: string; text?: string }[] }): unknown {
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block?.text, "tool result had no text");
  return JSON.parse(block.text);
}

test("stdio client reads ingested DMARC data from the live API", async () => {
  const seeded = seedBackend();
  const window = { day_after: seeded.day_after, day_before: seeded.day_before, domain: seeded.domain_id };
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: serverRoot,
    env: {
      MAILFACT_API_URL: "http://localhost:8000",
      MAILFACT_API_TOKEN: seeded.token,
    },
  });
  const client = new Client({ name: "mailfact-mcp-e2e", version: "0.0.0" });
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

    const domains = textOf(
      await client.callTool({ name: "list_domains", arguments: { fqdn: seeded.fqdn } }),
    ) as { results: { id: string; fqdn: string }[]; truncated: boolean };
    assert.equal(domains.truncated, false);
    assert.deepEqual(domains.results.map((row) => row.fqdn), [seeded.fqdn]);
    assert.equal(domains.results[0].id, seeded.domain_id);

    const sources = textOf(
      await client.callTool({ name: "list_sending_sources", arguments: window }),
    ) as { results: { source_ip: string; total: number }[]; group_by: string };
    assert.equal(sources.group_by, "source_ip");
    const top = sources.results[0];
    assert.equal(top.source_ip, seeded.source_ip);
    assert.equal(top.total, seeded.total);

    const who = textOf(await client.callTool({ name: "whoami", arguments: {} })) as {
      me: { user: null; active_org_slug: string };
      entitlement: { api_tokens_enabled: boolean };
    };
    assert.equal(who.me.user, null);
    assert.equal(who.me.active_org_slug, seeded.org_slug);
    assert.equal(typeof who.entitlement.api_tokens_enabled, "boolean");
  } finally {
    await client.close();
  }
});
