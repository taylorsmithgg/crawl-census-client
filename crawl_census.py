"""Crawl Census client: ask before you fetch.

A crawler normally decides where to go by parsing robots.txt. That answers one question and
hides two others, and both cost real requests:

- Thousands of domains publish a robots.txt permitting AI agents and then refuse those same
  agents at the network edge. A parser sees permission; the fetch returns 403.
- Some origins answer an AI user agent with HTTP 402 Payment Required. That is a price, not a
  refusal. Treating it as a block walks away from content the operator wants to sell; routing
  around it takes something they are charging for.

This module turns that measurement into behaviour.

Standard library only, Python 3.9+.

    from crawl_census import polite_fetch, preflight, partition

    r = polite_fetch("https://example.com/", agent="gptbot")
    if r.skipped:
        print(r.verdict, r.reason)
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

DEFAULT_ENDPOINT = "https://crawlcensus.com"
VERDICTS = ("allow", "unknown", "pay", "disallow", "refuse")
_BLOCKING = frozenset({"disallow", "refuse", "pay"})

__all__ = [
    "preflight",
    "polite_fetch",
    "partition",
    "agent_profile",
    "blocklist",
    "changes_since",
    "BlocklistSync",
    "to_domain",
    "Verdict",
    "FetchResult",
    "Partitioned",
    "VERDICTS",
]


@dataclass(frozen=True)
class Verdict:
    domain: str
    verdict: str
    reason: str = ""
    robots: str = "unknown"
    edge_refused: Optional[bool] = None
    charges: bool = False
    measured_at: Optional[str] = None
    report: str = ""

    @property
    def crawlable(self) -> bool:
        return self.verdict in ("allow", "unknown")


@dataclass
class FetchResult:
    domain: str
    verdict: str
    reason: str
    skipped: bool
    status: Optional[int] = None
    body: Optional[bytes] = None
    headers: dict = field(default_factory=dict)
    report: str = ""
    paid_route_overridden: bool = False


@dataclass
class Partitioned:
    crawl: list = field(default_factory=list)
    skip: list = field(default_factory=list)
    pay: list = field(default_factory=list)
    unknown: list = field(default_factory=list)
    verdicts: dict = field(default_factory=dict)


def to_domain(value: str) -> str:
    """Normalise anything URL-ish to a bare hostname."""
    if not value:
        return ""
    s = str(value).strip().lower()
    if not s:
        return ""
    if "://" not in s:
        s = "https://" + s
    try:
        host = urllib.parse.urlparse(s).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _post(url: str, payload: dict, api_key: Optional[str], timeout: float) -> dict:
    data = json.dumps(payload).encode()
    headers = {"content-type": "application/json", "user-agent": "crawl-census-client/1.0"}
    if api_key:
        headers["authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def preflight(
    domains: Iterable[str],
    *,
    agent: str,
    api_key: Optional[str] = None,
    endpoint: str = DEFAULT_ENDPOINT,
    chunk: Optional[int] = None,
    timeout: float = 15.0,
) -> list:
    """Check a batch of domains for one agent.

    An unreachable census yields ``unknown`` rather than raising: a crawl should degrade to its
    normal behaviour, not stop, because a third-party service is down.
    """
    if not agent:
        raise ValueError("preflight requires agent, e.g. 'gptbot'")
    seen, ordered = set(), []
    for d in domains:
        host = to_domain(d)
        if host and host not in seen:
            seen.add(host)
            ordered.append(host)
    if not ordered:
        return []
    size = chunk or (1000 if api_key else 25)
    out: list = []
    for i in range(0, len(ordered), size):
        batch = ordered[i : i + size]
        try:
            body = _post(endpoint + "/api/v1/preflight", {"agent": agent, "domains": batch}, api_key, timeout)
            for r in body.get("results", []):
                out.append(
                    Verdict(
                        domain=r.get("domain", ""),
                        verdict=r.get("verdict", "unknown"),
                        reason=r.get("reason", ""),
                        robots=r.get("robots", "unknown"),
                        edge_refused=r.get("edge_refused"),
                        charges=bool(r.get("charges")),
                        measured_at=r.get("measured_at"),
                        report=r.get("report", ""),
                    )
                )
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            for d in batch:
                out.append(Verdict(domain=d, verdict="unknown", reason="Census unreachable: %s" % str(exc)[:120]))
    return out


class _Cache:
    """Bounded TTL cache, so a long crawl does not leak."""

    def __init__(self, ttl: float = 3600.0, max_entries: int = 50_000) -> None:
        self._ttl = ttl
        self._max = max_entries
        self._data: dict = {}

    def get(self, key: str):
        hit = self._data.get(key)
        if not hit:
            return None
        value, expires = hit
        if time.time() > expires:
            self._data.pop(key, None)
            return None
        return value

    def set(self, key: str, value) -> None:
        if len(self._data) >= self._max:
            self._data.pop(next(iter(self._data)), None)
        self._data[key] = (value, time.time() + self._ttl)


shared_cache = _Cache()


def polite_fetch(
    url: str,
    *,
    agent: str,
    api_key: Optional[str] = None,
    endpoint: str = DEFAULT_ENDPOINT,
    cache: Optional[_Cache] = None,
    on_pay: str = "skip",
    allow_unknown: bool = True,
    timeout: float = 30.0,
) -> FetchResult:
    """Consult the census, then fetch or skip.

    Skipping is the normal outcome for a large share of the web, so it is returned rather than
    raised: a crawl loop should be able to count skips without wrapping every URL in try/except.

    ``on_pay='fetch'`` is an explicit opt-in to fetch an origin that quoted a price, and is
    recorded on the result so it appears in logs. The default refuses, because routing around
    HTTP 402 takes content someone is selling.
    """
    if not agent:
        raise ValueError("polite_fetch requires agent, e.g. 'gptbot'")
    cache = cache or shared_cache
    domain = to_domain(url)
    if not domain:
        raise ValueError("Not a usable URL: %s" % str(url)[:80])

    key = agent + ":" + domain
    verdict = cache.get(key)
    if verdict is None:
        found = preflight([domain], agent=agent, api_key=api_key, endpoint=endpoint, timeout=timeout)
        verdict = found[0] if found else Verdict(domain=domain, verdict="unknown", reason="No verdict returned.")
        cache.set(key, verdict)

    v = verdict.verdict
    if v == "pay" and on_pay == "fetch":
        status, body, headers = _get(url, agent, timeout)
        return FetchResult(domain, v, verdict.reason, False, status, body, headers, verdict.report, True)
    if v in _BLOCKING:
        return FetchResult(domain, v, verdict.reason, True, report=verdict.report)
    if v == "unknown" and not allow_unknown:
        return FetchResult(domain, v, verdict.reason or "Not measured, and allow_unknown is False.", True, report=verdict.report)

    status, body, headers = _get(url, agent, timeout)
    return FetchResult(domain, v, verdict.reason, False, status, body, headers, verdict.report)


def _get(url: str, agent: str, timeout: float):
    req = urllib.request.Request(url, headers={"user-agent": agent})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers or {})


def partition(urls: Iterable[str], **options: Any) -> Partitioned:
    """Split a work queue before crawling it: one call per 1,000 domains, not one per host."""
    by_domain: dict = {}
    for u in urls:
        d = to_domain(u)
        if not d:
            continue
        by_domain.setdefault(d, []).append(u)
    out = Partitioned()
    for v in preflight(by_domain.keys(), **options):
        out.verdicts[v.domain] = v
        urls_for = by_domain.get(v.domain, [])
        if v.verdict == "allow":
            out.crawl.extend(urls_for)
        elif v.verdict == "pay":
            out.pay.extend(urls_for)
        elif v.verdict == "unknown":
            out.unknown.extend(urls_for)
        else:
            out.skip.extend(urls_for)
    return out


def blocklist_with_cursor(agent: str, *, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 30.0) -> tuple:
    """The blocklist for one agent, plus the feed position it was built at.

    Returns ``(domains, cursor)``. The cursor matters: it is the point in the change feed that
    this exact list corresponds to, so a later poll resumes with no gap and no replay. Deriving
    a start position locally instead is wrong twice over, being both clock-skewed against the
    server and blind to anything written while the list was in flight.
    """
    req = urllib.request.Request(
        endpoint + "/agents/" + urllib.parse.quote(agent) + "/blocklist.txt",
        headers={"user-agent": "crawl-census-client/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode()
        cursor = resp.headers.get("x-cursor")
    domains = {ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")}
    return domains, cursor


def blocklist(agent: str, *, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 30.0) -> set:
    """The whole robots.txt blocklist for one agent, as a set of domains.

    One request instead of per-domain lookups. Covers robots.txt only: edge refusal and HTTP 402
    are per-request behaviours and still need ``preflight``. Use ``blocklist_with_cursor`` when
    the list will be kept current by polling.
    """
    return blocklist_with_cursor(agent, endpoint=endpoint, timeout=timeout)[0]


def changes_since(agent: str, frm, *, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 30.0) -> dict:
    """Changes for one agent, from a cursor or a unix timestamp.

    Prefer a cursor. A timestamp names only a second, and a crawl batch writes dozens of events
    into a single second, so resuming by second can drop the remainder of it.
    """
    token = str(frm)
    if re.fullmatch(r"\d+\.\d+", token):
        query = "cursor=" + urllib.parse.quote(token)
    else:
        try:
            query = "since=" + str(int(float(token)))
        except ValueError:
            query = "since=0"
    url = endpoint + "/agents/" + urllib.parse.quote(agent) + "/changes.json?" + query
    req = urllib.request.Request(url, headers={"user-agent": "crawl-census-client/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


class BlocklistSync:
    """Keep a deny list current without re-downloading it.

    Construction pulls the full list; ``refresh`` applies only what changed, which is a few
    hundred bytes rather than a few hundred kilobytes.
    """

    def __init__(self, agent: str, *, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 30.0) -> None:
        self.agent = agent
        self._endpoint = endpoint
        self._timeout = timeout
        self.blocked, cursor = blocklist_with_cursor(agent, endpoint=endpoint, timeout=timeout)
        # Server-supplied position, falling back to local time only if the header is absent.
        self.cursor = cursor or int(time.time())

    def __contains__(self, domain: str) -> bool:
        return to_domain(domain) in self.blocked

    def refresh(self) -> dict:
        delta = changes_since(self.agent, self.cursor, endpoint=self._endpoint, timeout=self._timeout)
        added = removed = 0
        for c in delta.get("changes", []):
            d = c.get("domain", "")
            if c.get("change") == "now_blocks_you":
                if d not in self.blocked:
                    added += 1
                self.blocked.add(d)
            elif d in self.blocked:
                self.blocked.discard(d)
                removed += 1
        self.cursor = delta.get("next_cursor") or delta.get("next_since") or self.cursor
        return {"added": added, "removed": removed, "size": len(self.blocked), "cursor": self.cursor}


def agent_profile(agent: str, *, endpoint: str = DEFAULT_ENDPOINT, timeout: float = 15.0) -> dict:
    """What the census publishes about your own agent, including how to correct it."""
    body = _post(
        endpoint + "/mcp",
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "agent_profile", "arguments": {"agent": agent}}},
        None,
        timeout,
    )
    content = (body.get("result") or {}).get("content") or []
    if not content:
        raise RuntimeError("agent_profile returned no content")
    return json.loads(content[0]["text"])
