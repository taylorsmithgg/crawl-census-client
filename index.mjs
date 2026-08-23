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
