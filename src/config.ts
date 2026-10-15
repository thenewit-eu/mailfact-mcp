import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Prefix the API counts. Keep this in lockstep with `MCP_USER_AGENT_PREFIX`. */
export const USER_AGENT_PREFIX = "mailfact-mcp/";

export const DEFAULT_API_ORIGIN = "https://api.mailfact.app";

export type Config = {
  apiOrigin: string;
  token: string;
  userAgent: string;
  version: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.MAILFACT_API_TOKEN?.trim();
  if (!token) {
    throw new Error("MAILFACT_API_TOKEN is required (Authorization: Token <raw>).");
  }
  const raw = (env.MAILFACT_API_URL ?? DEFAULT_API_ORIGIN).trim();
  const apiOrigin = raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  if (!apiOrigin.startsWith("http://") && !apiOrigin.startsWith("https://")) {
    throw new Error("MAILFACT_API_URL must be an http(s) origin.");
  }
  return {
    apiOrigin,
    token,
    userAgent: `${USER_AGENT_PREFIX}${version}`,
    version,
  };
}
