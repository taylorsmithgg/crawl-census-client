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
export async function preflightV2(domains, { agent, apiKey, endpoint = DEFAULT_ENDPOINT, chunk, signal } = {}) {
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
 * Resolve one domain's verdict, sharing work with every other lookup in flight.
 *
 * Measured against the live census before this existed: twenty hosts fetched concurrently cost
 * twenty preflight calls carrying one domain each, and the same host requested three times at
 * once cost three - the cache only helps after the first resolves, which is exactly when a
 * concurrent crawler has not got there yet. The endpoint accepts up to a thousand domains in
 * one call, so a crawler was paying per host against an allowance meant to cover a thousand.
 *
 * Two mechanisms, both small:
 *
 *   - An in-flight map keyed by agent and domain, so concurrent lookups for one host await a
 *     single request instead of racing to make their own.
 *   - A queue drained on the next tick, so lookups issued in the same burst leave as one
 *     batched call. `batchWaitMs` widens the window for a crawler whose concurrency arrives
 *     in waves rather than all at once; `batchSize` must stay within the caller's plan cap,
 *     which is 25 domains per call without a key.
 *
 * A failed batch rejects only its own members. One bad request must not poison a crawl.
 */
const inflight = new Map();
const pending = new Map();
let pendingTimer = null;

function batchKey({ agent, endpoint, apiKey }) {
  return `${agent}\u0000${endpoint}\u0000${apiKey ?? ""}`;
}

async function flushPending() {
  pendingTimer = null;
  const groups = [...pending.entries()];
  pending.clear();
  for (const [, group] of groups) {
    const { options, waiters } = group;
    const domains = [...waiters.keys()];
    const size = options.batchSize ?? 25;
    for (let i = 0; i < domains.length; i += size) {
      const slice = domains.slice(i, i + size);
      try {
        const rows = await preflight(slice, options);
        const byDomain = new Map(rows.map((r) => [r.domain, r]));
        for (const d of slice) {
          for (const resolve of waiters.get(d).resolvers) resolve(byDomain.get(d) ?? null);
          inflight.delete(`${options.agent}:${d}`);
        }
      } catch (err) {
        for (const d of slice) {
          for (const reject of waiters.get(d).rejecters) reject(err);
          inflight.delete(`${options.agent}:${d}`);
        }
      }
    }
  }
}

function lookupVerdict(domain, options) {
  const key = `${options.agent}:${domain}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = new Promise((resolve, reject) => {
    const gk = batchKey(options);
    let group = pending.get(gk);
    if (!group) {
      group = { options, waiters: new Map() };
      pending.set(gk, group);
    }
    let entry = group.waiters.get(domain);
    if (!entry) {
      entry = { resolvers: [], rejecters: [] };
      group.waiters.set(domain, entry);
    }
    entry.resolvers.push(resolve);
    entry.rejecters.push(reject);
    if (!pendingTimer) {
      const wait = options.batchWaitMs ?? 0;
      // Deliberately not unref'd. The flush is what settles every awaiting lookup, so a timer
      // the runtime is free to skip means a caller awaiting a single verdict never resolves -
      // observed immediately as "unsettled top-level await" the first time the suite ran it.
      // The delay is zero or a few milliseconds, so it cannot meaningfully hold a process open.
      pendingTimer = setTimeout(flushPending, wait > 0 ? wait : 0);
    }
  });
  inflight.set(key, promise);
  return promise;
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
export async function politeFetch(url, { agent, apiKey, endpoint = DEFAULT_ENDPOINT, cache = sharedCache, batchSize, batchWaitMs, onPay = "skip", allowUnknown = true, fetchOptions = {}, signal } = {}) {
  if (!agent) throw new TypeError("politeFetch requires { agent }, e.g. 'gptbot'");
  const domain = toDomain(url);
  if (!domain) throw new TypeError(`Not a usable URL: ${String(url).slice(0, 80)}`);

  const key = `${agent}:${domain}`;
  let verdict = cache.get(key);
  if (!verdict) {
    verdict = await lookupVerdict(domain, { agent, apiKey, endpoint, signal, batchSize, batchWaitMs });
    if (verdict) cache.set(key, verdict);
  }
  const v = verdict?.verdict ?? "unknown";

  /**
   * The amount travels with the verdict.
   *
   * A `pay` result used to carry only the reason string, so an operator willing to buy had to
   * parse prose or go back to the census. Four origins in the corpus quote a real amount, and
   * the decision to pay one cent is not the decision to pay fifty.
   */
  const price = verdict?.price ?? null;

  if (v === "pay" && onPay === "fetch") {
    // Explicit opt-in only, and recorded on the result so it shows up in logs.
    const response = await fetch(url, { signal, ...fetchOptions });
    return { skipped: false, verdict: v, reason: verdict?.reason ?? "", price, paidRouteOverridden: true, response, domain };
  }
  if (BLOCKING.has(v)) {
    return { skipped: true, verdict: v, reason: verdict?.reason ?? "", price, response: null, domain, report: verdict?.report ?? "" };
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
  const { cache = sharedCache } = options ?? {};
  const byDomain = new Map();
  for (const u of urls) {
    const d = toDomain(u);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(u);
  }
  const verdicts = await preflight([...byDomain.keys()], options);
  const out = { crawl: [], skip: [], pay: [], unknown: [], undecidable: [], verdicts: new Map(), unmeasured: [] };
  for (const v of verdicts) {
    out.verdicts.set(v.domain, v);
    /**
     * Warm the cache politeFetch reads.
     *
     * The documented pattern is partition a queue, then fetch what it says to fetch - and it
     * cost two census calls for one queue, because partition looked every domain up and then
     * dropped the answers on the floor. Measured at four domains: one call to partition, then
     * a second for the two it said were crawlable. Writing them through makes the second call
     * disappear, which for a crawler running this loop continuously is half its census traffic.
     */
    if (cache && options?.agent) cache.set(`${options.agent}:${v.domain}`, v);
    const urlsFor = byDomain.get(v.domain) ?? [];
    if (v.verdict === "allow") out.crawl.push(...urlsFor);
    else if (v.verdict === "pay") out.pay.push(...urlsFor);
    else if (v.verdict === "unknown") {
      /**
       * Two unknowns with opposite correct actions, previously one bucket.
       *
       * A domain the census has not measured yet becomes answerable the moment it is
       * submitted. A domain whose robots.txt disallows CrawlCensusBot never will: asking
       * again is guaranteed waste, and a loop that retries its unknowns each run would
       * retry those forever. `measurable` is the server's machine-readable answer to
       * which is which - do not match on the reason text, which is prose and will change.
       */
      if (v.measurable === false) out.undecidable.push(...urlsFor);
      else {
        out.unknown.push(...urlsFor);
        out.unmeasured.push(v.domain);
      }
    } else out.skip.push(...urlsFor);
  }
  return out;
}

/**
 * Hand the unmeasured domains from a partition back to the census.
 *
 * Explicit rather than automatic: a library that quietly POSTs during what reads as a lookup
 * is a bad citizen, and an operator should choose when their queue positions are spent. The
 * domains that can never be measured are excluded here as well as server-side, so calling
 * this in a loop converges instead of resubmitting the same refusals every pass.
 *
 *   const p = await partition(urls, { agent: "gptbot" });
 *   if (p.unmeasured.length) await submitUnmeasured(p, { agent: "gptbot", apiKey });
 *   // next run, those domains answer with a real verdict
 */
export async function submitUnmeasured(partitioned, { endpoint = DEFAULT_ENDPOINT, apiKey, key, signal } = {}) {
  /**
   * `apiKey`, matching every other function here.
   *
   * This one took `key` while preflight, politeFetch and partition all take `apiKey`, so
   * passing the same options object to two functions silently authenticated one and not the
   * other - which presents as a rate limit rather than an auth error, and sends the reader
   * looking in the wrong place. `key` still works so nobody's code breaks.
   */
  const token = apiKey ?? key;
  const domains = partitioned?.unmeasured ?? [];
  if (!domains.length) return { submitted: 0, queued: 0, declined: [], already_fresh: [] };
  const res = await fetch(`${endpoint}/api/v1/scan`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ domains }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`submit returned ${res.status}${detail.error ? `: ${detail.error}` : ""}`);
  }
  return res.json();
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
      const other = [];
      /**
       * Only robots transitions move a robots-derived list.
       *
       * This read `change === "now_blocks_you" ? add : delete`, so every other kind of change
       * removed the domain. Once the census began reporting edge refusals and new prices, a
       * domain that had just started refusing this crawler was deleted from the deny list -
       * the caller would resume fetching precisely what had begun rejecting it. The feed also
       * publishes `kind`, but matching on the label is what shipped, so both are handled.
       *
       * Everything else is returned rather than swallowed: a new price or a new edge refusal
       * is worth acting on, just not by editing a list of who disallows you.
       */
      for (const c of delta.changes ?? []) {
        if (c.change === "now_blocks_you") {
          if (!blocked.has(c.domain)) added++;
          blocked.add(c.domain);
        } else if (c.change === "no_longer_blocks_you") {
          if (blocked.delete(c.domain)) removed++;
        } else {
          other.push(c);
        }
      }
      cursor = delta.next_cursor ?? delta.next_since ?? cursor;
      return { added, removed, size: blocked.size, cursor, other };
    },
  };
}


/**
 * Every reason not to fetch, in one membership test, kept current by the delta feed.
 *
 * `syncBlocklist` covers robots disallows only, which is the smaller half of the problem.
 * Measured against the live census: a crawler skipping only the deny list still spends about
 * 2,900 requests per pass on domains that permit it in robots and refuse it at the edge, or
 * that answer 402 - and for PerplexityBot that set is larger than the deny list itself. Those
 * fetches return nothing and cost a round trip each.
 *
 * The three lists are kept apart internally so a change applies to the one it belongs to. That
 * matters: the previous sync deleted a domain from the deny list when it started refusing at
 * the edge, because it matched "not a block" and removed. Here an edge transition moves the
 * edge set and leaves robots alone.
 *
 *   const skip = await syncSkipList("gptbot");
 *   if (skip.has(host)) continue;          // disallowed, refused, or priced
 *   skip.why(host);                        // "disallow" | "refuse" | "pay" | null
 *   setInterval(() => skip.refresh(), 3600_000);
 */
export async function syncSkipList(agent, { endpoint = DEFAULT_ENDPOINT, apiKey, signal } = {}) {
  const fetchList = async (name) => {
    const res = await fetch(`${endpoint}/agents/${encodeURIComponent(agent)}/${name}`, {
      signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`${name} for ${agent} returned ${res.status}`);
    const text = await res.text();
    const set = new Set();
    for (const line of text.split("\n")) {
      const d = line.trim().split(" ")[0];
      if (d && !d.startsWith("#")) set.add(d);
    }
    return { set, cursor: res.headers.get("x-cursor") };
  };

  const [blocked, refused, charged] = await Promise.all([fetchList("blocklist.txt"), fetchList("refused.txt"), fetchList("charging.txt")]);
  // The blocklist carries the feed position it was built at; the other two are generated from
  // the same event log, so resuming from it covers all three without a fourth request.
  let cursor = blocked.cursor ?? Math.floor(Date.now() / 1000);

  const sets = { disallow: blocked.set, refuse: refused.set, pay: charged.set };

  return {
    agent,
    sets,
    get cursor() {
      return cursor;
    },
    get size() {
      return new Set([...sets.disallow, ...sets.refuse, ...sets.pay]).size;
    },
    /** True when this crawler should not spend a request on the host. */
    has(input) {
      const d = toDomain(input) || input;
      return sets.disallow.has(d) || sets.refuse.has(d) || sets.pay.has(d);
    },
    /**
     * Why, in the same precedence preflight uses: a disallow outranks a price, because a price
     * is not permission, and an edge refusal is reported only when robots permits the fetch.
     */
    why(input) {
      const d = toDomain(input) || input;
      if (sets.disallow.has(d)) return "disallow";
      if (sets.pay.has(d)) return "pay";
      if (sets.refuse.has(d)) return "refuse";
      return null;
    },
    async refresh() {
      const delta = await changesSince(agent, cursor, { endpoint, signal });
      const moves = { disallow: 0, refuse: 0, pay: 0, ignored: 0 };
      for (const c of delta.changes ?? []) {
        switch (c.change) {
          case "now_blocks_you":
            sets.disallow.add(c.domain);
            moves.disallow++;
            break;
          case "no_longer_blocks_you":
            sets.disallow.delete(c.domain);
            moves.disallow++;
            break;
          case "now_refuses_you_at_the_edge":
            sets.refuse.add(c.domain);
            moves.refuse++;
            break;
          case "no_longer_refuses_you_at_the_edge":
            sets.refuse.delete(c.domain);
            moves.refuse++;
            break;
          case "now_charges_you":
            sets.pay.add(c.domain);
            moves.pay++;
            break;
          case "no_longer_charges_you":
            sets.pay.delete(c.domain);
            moves.pay++;
            break;
          default:
            // An llms.txt appearing or a score moving does not change whether to fetch.
            moves.ignored++;
        }
      }
      cursor = delta.next_cursor ?? delta.next_since ?? cursor;
      return { ...moves, size: this.size, cursor };
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
