/** Host the live e2e is allowed to call. Production is refused. */
export const DEV_API_ORIGIN = "https://api.dev.mailfact.app";

const DEV_HOST = "api.dev.mailfact.app";

/**
 * Accept only the Mailfact dev origin. A public pull request must not be
 * able to point this suite at another host and receive the dev token.
 */
export function devApiOrigin(raw: string | undefined): string {
  if (!raw?.trim()) {
    throw new Error("MAILFACT_API_URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("live e2e only runs against the Mailfact dev API");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const allowed =
    url.protocol === "https:" &&
    url.hostname === DEV_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    path === "";
  if (!allowed) {
    throw new Error("live e2e only runs against the Mailfact dev API");
  }
  return DEV_API_ORIGIN;
}
