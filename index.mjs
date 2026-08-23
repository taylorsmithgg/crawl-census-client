/**
 * Crawl Census client: ask before you fetch.
 *
 * A crawler normally decides where to go by parsing robots.txt. That answers one question and
 * hides two others, and both cost real requests:
 *
 *   - Thousands of domains publish a robots.txt that permits AI agents and then refuse those
 *     same agents at the network edge. A parser sees permission; the fetch returns 403. You
 *     paid for the round trip and got nothing.
 *   - Some origins answer an AI user agent with HTTP 402 Payment Required. That is a price,
 *     not a refusal. Treating it as a block walks away from content the operator wants to
 *     sell you. Retrying around it takes something they are charging for.
 *
 * This module turns that measurement into behaviour. `politeFetch` consults the census before
 * spending a request, skips doors that are shut, and refuses to route around a paywall.
 *
 * Zero dependencies. Node 18+ or any runtime with global fetch.
 *
 *   import { politeFetch, preflight } from "crawl-census-client";
 *
 *   const res = await politeFetch("https://example.com/", { agent: "gptbot" });
 *   if (res.skipped) console.log(res.verdict, res.reason);
 */

const DEFAULT_ENDPOINT = "https://crawlcensus.com";

/** Verdicts, in the order of how much they should worry a crawler operator. */
export const VERDICTS = Object.freeze(["allow", "unknown", "pay", "disallow", "refuse"]);

/** Verdicts that mean "do not send the request". */
const BLOCKING = new Set(["disallow", "refuse", "pay"]);

class Cache {
  #map = new Map();
  #ttl;
  #max;
  constructor(ttlMs = 3600_000, max = 50_000) {
    this.#ttl = ttlMs;
    this.#max = max;
  }
  get(k) {
    const hit = this.#map.get(k);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.#map.delete(k);
      return undefined;
    }
    return hit.value;
  }
  set(k, value) {
    // Bounded: a long crawl must not turn the cache into a memory leak.
    if (this.#map.size >= this.#max) this.#map.delete(this.#map.keys().next().value);
    this.#map.set(k, { value, expires: Date.now() + this.#ttl });
  }
  get size() {
    return this.#map.size;
  }
}

/**
 * Check a batch of domains for one agent.
 *
 * Domains are deduplicated and chunked to the anonymous limit unless a key raises it. Network
 * failure is never fatal: an unreachable census returns `unknown` for everything, so a crawl
 * degrades to its normal behaviour rather than stopping.
 */
export async function preflight(domains, { agent, apiKey, endpoint = DEFAULT_ENDPOINT, chunk, signal } = {}) {
  if (!agent) throw new TypeError("preflight requires { agent }, e.g. 'gptbot'");
  const list = [...new Set((Array.isArray(domains) ? domains : [domains]).map(toDomain).filter(Boolean))];
  if (!list.length) return [];
  const size = chunk ?? (apiKey ? 1000 : 25);
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    try {
      const res = await fetch(`${endpoint}/api/v1/preflight`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ agent, domains: batch }),
      });
      if (!res.ok) throw new Error(`preflight returned ${res.status}`);
      const body = await res.json();
      out.push(...(body.results ?? []));
    } catch (err) {
      // Degrade, never block the caller's crawl on our availability.
      for (const d of batch) out.push({ domain: d, verdict: "unknown", reason: `Census unreachable: ${String(err).slice(0, 120)}`, robots: "unknown", edge_refused: null, charges: false, measured_at: null, report: "" });
    }
  }
  return out;
}

/** Normalise anything URL-ish to a bare hostname. */
export function toDomain(input) {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  if (!s.includes("://")) s = `https://${s}`;
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * A crawler-aware fetch.
 *
 * Consults the census, then either performs the fetch or returns a skip record explaining why
 * it did not. The skip record is deliberately not an exception: skipping is the normal, correct
 * outcome for a large share of the web, and a crawl loop should be able to count skips without
 * a try/catch around every URL.
 *
 * `onPay` decides what to do with an origin that quoted a price. The default is to skip, which
 * is the only defensible default: routing around a 402 takes content someone is selling.
 */
export async function politeFetch(url, { agent, apiKey, endpoint = DEFAULT_ENDPOINT, cache = sharedCache, onPay = "skip", allowUnknown = true, fetchOptions = {}, signal } = {}) {
  if (!agent) throw new TypeError("politeFetch requires { agent }, e.g. 'gptbot'");
  const domain = toDomain(url);
  if (!domain) throw new TypeError(`Not a usable URL: ${String(url).slice(0, 80)}`);

  const key = `${agent}:${domain}`;
  let verdict = cache.get(key);
  if (!verdict) {
    [verdict] = await preflight([domain], { agent, apiKey, endpoint, signal });
    if (verdict) cache.set(key, verdict);
  }
  const v = verdict?.verdict ?? "unknown";

  if (v === "pay" && onPay === "fetch") {
    // Explicit opt-in only, and recorded on the result so it shows up in logs.
    const response = await fetch(url, { signal, ...fetchOptions });
    return { skipped: false, verdict: v, reason: verdict?.reason ?? "", paidRouteOverridden: true, response, domain };
  }
  if (BLOCKING.has(v)) {
    return { skipped: true, verdict: v, reason: verdict?.reason ?? "", response: null, domain, report: verdict?.report ?? "" };
  }
  if (v === "unknown" && !allowUnknown) {
    return { skipped: true, verdict: v, reason: verdict?.reason ?? "Not measured, and allowUnknown is false.", response: null, domain, report: verdict?.report ?? "" };
  }
  const response = await fetch(url, { signal, ...fetchOptions });
  return { skipped: false, verdict: v, reason: verdict?.reason ?? "", response, domain };
}

/** Shared across calls so a crawl of many URLs on one host costs one census lookup. */
export const sharedCache = new Cache();

/** Build an isolated cache, e.g. per crawl job. */
export function createCache(ttlMs, max) {
  return new Cache(ttlMs, max);
}

/**
 * Split a work queue before crawling it. Cheaper than politeFetch per URL when the whole list
 * is known up front: one call per 1,000 domains instead of one per host.
 */
export async function partition(urls, options) {
  const byDomain = new Map();
  for (const u of urls) {
    const d = toDomain(u);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(u);
  }
  const verdicts = await preflight([...byDomain.keys()], options);
  const out = { crawl: [], skip: [], pay: [], unknown: [], verdicts: new Map() };
  for (const v of verdicts) {
    out.verdicts.set(v.domain, v);
    const urlsFor = byDomain.get(v.domain) ?? [];
    if (v.verdict === "allow") out.crawl.push(...urlsFor);
    else if (v.verdict === "pay") out.pay.push(...urlsFor);
    else if (v.verdict === "unknown") out.unknown.push(...urlsFor);
    else out.skip.push(...urlsFor);
  }
  return out;
}

/**
 * Fetch the whole robots.txt blocklist for one agent as a Set of domains.
 *
 * This is the cheap path for a fetcher that just wants a deny list in memory: one request,
 * a few hundred kilobytes, no per-domain lookups at crawl time. It covers robots.txt only.
 * Edge refusal and HTTP 402 are per-request behaviours and still need `preflight`.
 */
export async function blocklist(agent, { endpoint = DEFAULT_ENDPOINT, signal } = {}) {
  const res = await fetch(`${endpoint}/agents/${encodeURIComponent(agent)}/blocklist.txt`, { signal });
  if (!res.ok) throw new Error(`blocklist for ${agent} returned ${res.status}`);
  const text = await res.text();
  const domains = new Set();
  const cursor = res.headers.get("x-cursor") || null;
  for (const line of text.split("\n")) {
    const d = line.trim();
    if (d && !d.startsWith("#")) domains.add(d);
  }
  // The list is served with the feed position it was built at, in a header and in the
  // comment block. Carrying it means a refresh resumes exactly where the list ends.
  domains.cursor = cursor;
  return domains;
}

/**
 * Changes for one agent.
 *
 * `from` is either an opaque cursor from a previous response or the blocklist header, or a
 * unix timestamp. Prefer the cursor: a timestamp names only a second, and a crawl batch
 * writes dozens of events into one, so resuming by second can drop the rest of it.
 */
export async function changesSince(agent, from, { endpoint = DEFAULT_ENDPOINT, signal } = {}) {
  const q = /^\d+\.\d+$/.test(String(from)) ? `cursor=${encodeURIComponent(String(from))}` : `since=${Math.floor(Number(from) || 0)}`;
  const res = await fetch(`${endpoint}/agents/${encodeURIComponent(agent)}/changes.json?${q}`, { signal });
  if (!res.ok) throw new Error(`changes for ${agent} returned ${res.status}`);
  return res.json();
}

/**
 * Keep a deny list current without re-downloading it.
 *
 * First call pulls the full list. Every later call asks only for what changed and applies the
 * delta in place, which is a few hundred bytes instead of a few hundred kilobytes. Intended to
 * be run on a timer inside a long-lived crawler.
 *
 *   const sync = await syncBlocklist("gptbot");
 *   if (sync.blocked.has(host)) skip();
 *   setInterval(() => sync.refresh(), 3600_000);
 */
export async function syncBlocklist(agent, options = {}) {
  const blocked = await blocklist(agent, options);
  /**
   * Start from the position the list was built at, not from this machine's clock.
   *
   * Seeding with `Date.now()` was wrong twice: it is skewed against the server, and it
   * ignores anything written between the list being generated and the first refresh.
   * Both errors present as a deny list that quietly misses domains.
   */
  let cursor = blocked.cursor ?? Math.floor(Date.now() / 1000);
  return {
    agent,
    blocked,
    get cursor() {
      return cursor;
    },
    async refresh() {
      const delta = await changesSince(agent, cursor, options);
      let added = 0;
      let removed = 0;
      for (const c of delta.changes ?? []) {
        if (c.change === "now_blocks_you") {
          if (!blocked.has(c.domain)) added++;
          blocked.add(c.domain);
        } else {
          if (blocked.delete(c.domain)) removed++;
        }
      }
      cursor = delta.next_cursor ?? delta.next_since ?? cursor;
      return { added, removed, size: blocked.size, cursor };
    },
  };
}

/** What the census publishes about your own agent, including how to correct it. */
export async function agentProfile(agent, { endpoint = DEFAULT_ENDPOINT, signal } = {}) {
  const res = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_profile", arguments: { agent } } }),
  });
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  if (!text) throw new Error("agent_profile returned no content");
  return JSON.parse(text);
}
