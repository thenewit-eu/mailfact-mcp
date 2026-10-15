#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MailfactClient } from "./api.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({ name: "mailfact", version: config.version });
  registerTools(server, new MailfactClient(config));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "mailfact-mcp failed to start";
  console.error(message);
  process.exit(1);
});
