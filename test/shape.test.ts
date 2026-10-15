import assert from "node:assert/strict";
import test from "node:test";

import {
  RESULT_CAP,
  capOffset,
  capPage,
  continueQuery,
  cursorFromNext,
  encodePageToken,
  shapeValue,
} from "../dist/shape.js";
import { apiErrorFromEnvelope } from "../dist/api.js";
import { devApiOrigin } from "./dev-target.ts";

test("third-party strings are length-capped, including nested ones", () => {
  const shaped = shapeValue({
    header_from: "a".repeat(200),
    source_ip: "203.0.113.10",
    identifiers: { header_from: "b".repeat(200), envelope_from: "short.example" },
    alignment: { dkim: true, spf: false },
    policy_evaluated: {
      disposition: "q".repeat(200),
      dkim: "d".repeat(200),
      spf: "s".repeat(200),
    },
  }) as {
    header_from: string;
    source_ip: string;
    identifiers: { header_from: string; envelope_from: string };
    alignment: { dkim: boolean; spf: boolean };
    policy_evaluated: { disposition: string; dkim: string; spf: string };
  };
  assert.equal(shaped.header_from.length, 120);
  assert.equal(shaped.source_ip, "203.0.113.10");
  assert.equal(shaped.identifiers.header_from.length, 120);
  assert.equal(shaped.identifiers.envelope_from, "short.example");
  assert.equal(shaped.alignment.dkim, true);
  assert.equal(shaped.alignment.spf, false);
  assert.equal(shaped.policy_evaluated.disposition.length, 120);
  assert.equal(shaped.policy_evaluated.dkim.length, 120);
  assert.equal(shaped.policy_evaluated.spf.length, 120);
});

test("a page longer than the cap is cut and does not hand back a cursor that would skip rows", () => {
  const rows = Array.from({ length: RESULT_CAP + 5 }, (_, i) => ({ n: i }));
  const page = capPage(rows, "next-cursor");
  assert.equal(page.results.length, RESULT_CAP);
  assert.equal(page.truncated, true);
  assert.equal(page.next_cursor, undefined);
  assert.equal((page.results[0] as { n: number }).n, 0);
});

test("day windows keep the most recent rows when the cap hits", () => {
  const rows = Array.from({ length: RESULT_CAP + 2 }, (_, i) => ({ day: i }));
  const page = capPage(rows, null, "tail");
  assert.equal((page.results[0] as { day: number }).day, 2);
  assert.equal((page.results.at(-1) as { day: number }).day, RESULT_CAP + 1);
});

test("a following page is returned as a cursor and not fetched", () => {
  const page = capPage([{ n: 1 }], "abc");
  assert.equal(page.truncated, true);
  assert.equal(page.next_cursor, "abc");
  assert.deepEqual(page.results, [{ n: 1 }]);
});

test("cursorFromNext reads the cursor param and ignores other hosts' paths", () => {
  assert.equal(
    cursorFromNext("https://api.mailfact.app/api/v1/reports/records/?cursor=abc&page_size=50"),
    "abc",
  );
  assert.equal(cursorFromNext(null), null);
  assert.equal(cursorFromNext("not a url"), null);
});

test("a page token continues the same filters when the follow-up sends only the cursor", () => {
  const token = encodePageToken({ domain: "domain-a", day: "2026-01-01", cursor: "old" }, "api-cursor");
  const continued = continueQuery({ cursor: token, domain: "domain-b" });
  assert.equal(continued.domain, "domain-a");
  assert.equal(continued.day, "2026-01-01");
  assert.equal(continued.cursor, "api-cursor");
});

test("an offset walks the rest of an aggregate report", () => {
  const rows = Array.from({ length: RESULT_CAP + 10 }, (_, i) => ({ n: i }));
  const first = capOffset(rows, 0);
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, RESULT_CAP);
  assert.equal((first.results[0] as { n: number }).n, 0);
  const second = capOffset(rows, first.next_offset ?? 0);
  assert.equal(second.truncated, false);
  assert.equal(second.next_offset, undefined);
  assert.equal((second.results[0] as { n: number }).n, RESULT_CAP);
  assert.equal(second.results.length, 10);
});

test("live e2e accepts only the Mailfact dev origin", () => {
  assert.equal(devApiOrigin("https://api.dev.mailfact.app"), "https://api.dev.mailfact.app");
  assert.equal(devApiOrigin("https://api.dev.mailfact.app/"), "https://api.dev.mailfact.app");
  assert.equal(devApiOrigin("https://api.dev.mailfact.app/api/v1"), "https://api.dev.mailfact.app");
  for (const rejected of [
    undefined,
    "",
    "https://api.mailfact.app",
    "http://api.dev.mailfact.app",
    "https://user:secret@api.dev.mailfact.app",
    "https://api.dev.mailfact.app.evil.example",
    "https://api.dev.mailfact.app/other",
    "https://api.dev.mailfact.app/?token=1",
  ]) {
    assert.throws(() => devApiOrigin(rejected), /Mailfact dev API|MAILFACT_API_URL is required/);
  }
});

test("an API error keeps the field details", () => {
  const error = apiErrorFromEnvelope(400, "Bad Request", {
    error: { code: "invalid", message: "Request failed", details: { fqdn: ["not a valid FQDN"] } },
  });
  assert.equal(error.message, "Request failed");
  assert.deepEqual(error.details, { fqdn: ["not a valid FQDN"] });
});
