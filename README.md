# mailfact-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for a Mailfact
tenant. Tools return DMARC counts and rows. They do not recommend a
policy, score a domain, or call a model.

The server speaks `Authorization: Token` to the Mailfact API and
identifies itself with `User-Agent: mailfact-mcp/<version>`.

## Configure

| Variable | Required | Default |
|---|---|---|
| `MAILFACT_API_TOKEN` | yes | — |
| `MAILFACT_API_URL` | no | `https://api.mailfact.app` |

Mint the token in the product (`POST /api/v1/tokens/`). A `read` scope
is enough. The raw value is shown once.

Self-hosted and `external_billing` deployments use the same server:
set `MAILFACT_API_URL` to that origin (`https://api.example.com`, with
or without a trailing `/api/v1`).

Until this package is on npm, run it from a checkout.

```bash
npm install
npm run build
MAILFACT_API_TOKEN=dmr_… node dist/index.js
```

## Cursor

Add the token in Cursor after installing. The deeplink does not carry it, and it uses `npx`, so it works once the package is published.

[Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=mailfact&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1haWxmYWN0LW1jcCJdLCJlbnYiOnsiTUFJTEZBQ1RfQVBJX1VSTCI6Imh0dHBzOi8vYXBpLm1haWxmYWN0LmFwcCJ9fQ==)

Or `~/.cursor/mcp.json` (use `node` and the `dist/index.js` path until publish):

```json
{
  "mcpServers": {
    "mailfact": {
      "command": "npx",
      "args": ["-y", "mailfact-mcp"],
      "env": {
        "MAILFACT_API_TOKEN": "dmr_…",
        "MAILFACT_API_URL": "https://api.mailfact.app"
      }
    }
  }
}
```

## Claude Desktop and Claude Code

Same `mcpServers` block, in `claude_desktop_config.json` or the project's
`.mcp.json`.

## Tools

| Tool | API |
|---|---|
| `list_domains` | `GET /domains/?fqdn=` |
| `get_domain` | `GET /domains/{id}/` |
| `get_alignment_summary` | `GET /reports/records/summary/?group_by=day` |
| `get_reporter_coverage` | `GET /reports/records/summary/?group_by=reporter_org` |
| `list_sending_sources` | `GET /reports/records/summary/?group_by=source_ip` (also `source_ip_asn`, `header_from`) |
| `query_records` | `GET /reports/records/` |
| `list_aggregate_reports` | `GET /reports/aggregate/` |
| `get_report_records` | `GET /reports/aggregate/{id}/records/` |
| `whoami` | `GET /me/` and `GET /billing/entitlement/resolved/` |

Fact-table tools return at most 50 rows. `truncated: true` means the
response was cut. Paginated tools also return `next_cursor`; pass it
back as `cursor`. They do not follow further pages themselves.

`reporter_org`, `header_from`, and the other third-party name fields
are cut at 120 characters.

Not exposed: token minting, billing checkout, forensic message bodies.

## Tests

```bash
npm test
```

`npm test` checks row caps and error details. It does not call the API.

`npm run test:e2e` rebuilds the sibling `dmarc-reporting` `web` image,
ingests a real aggregate report, and calls the tools over stdio. It
needs Docker. GitHub Actions does not run it.

GitHub Actions runs `npm test` on every push and pull request. It does
not call the dev API. A self-hosted runner on this public repository
would let a fork pull request execute its own workflow on that machine.

The live dev test stays manual: `npm run test:e2e:live`.
That command loads the read token from `.env.e2e`.
