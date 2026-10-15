"""Seed one real aggregate report for the MCP end-to-end test.

Runs inside the backend's web container (`manage.py shell -c`). Prints a
single JSON line the test parses. Re-running deletes the previous raw
message so the sha256 short-circuit does not skip persistence.
"""

import json

from django.utils import timezone

from apps.accounts.models import ApiToken, Organization
from apps.accounts.services import generate_api_token
from apps.domains.models import Domain
from apps.domains.services import rua_inbox_address
from apps.ingest.parser import parse_and_persist
from apps.reports.models import AggregateReport, RawMessage, RecordDaily
from tests.fixtures import build_rua_mime

org, _created = Organization.objects.get_or_create(
    slug="mcp-e2e",
    defaults={"name": "MCP E2E"},
)
domain, _created = Domain.objects.get_or_create(org=org, fqdn="mcp-e2e.example")
if domain.verified_at is None:
    domain.verified_at = timezone.now()
    domain.save(update_fields=["verified_at"])

RecordDaily.objects.filter(org=org).delete()
AggregateReport.objects.filter(org=org).delete()
RawMessage.objects.filter(org=org).delete()

recipient = rua_inbox_address(domain)
parse_and_persist(build_rua_mime(reporter="google"), recipient=recipient)

rows = list(RecordDaily.objects.filter(org=org, domain=domain))
if not rows:
    raise SystemExit("ingest produced no fact rows")
days = sorted({row.day for row in rows})
by_ip: dict[str, int] = {}
for row in rows:
    ip = str(row.source_ip)
    by_ip[ip] = by_ip.get(ip, 0) + row.count
source_ip, total = max(by_ip.items(), key=lambda item: item[1])

ApiToken.objects.filter(org=org, label="mcp-e2e").delete()
minted = generate_api_token()
ApiToken.objects.create(
    org=org,
    label="mcp-e2e",
    token_hash=minted.token_hash,
    scopes=["read"],
)

print(
    "MCP_E2E_JSON "
    + json.dumps(
        {
            "token": minted.raw,
            "domain_id": str(domain.id),
            "fqdn": domain.fqdn,
            "day_after": days[0].isoformat(),
            "day_before": days[-1].isoformat(),
            "source_ip": source_ip,
            "total": total,
            "org_slug": org.slug,
        }
    )
)
