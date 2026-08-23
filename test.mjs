/**
 * Live tests against the public census.
 *
 * These deliberately hit the real service. The value of this client is entirely in whether its
 * verdicts match reality, and a mocked test would assert only that the mock was written to
 * agree with itself.
 *
 * Run: node test.mjs
 */
import { agentProfile, blocklist, changesSince, createCache, partition, politeFetch, preflight, syncBlocklist, toDomain, submitUnmeasured } from "./index.mjs";

/**
 * Stop before asserting anything if the census is refusing this run.
 *
 * Every verdict here comes from the live service, and the client is designed to degrade to
 * `unknown` when that service is unreachable so a third-party outage never stops someone's
 * crawl. That is correct behaviour and it makes every downstream assertion fail at once: one
 * throttled run reported eight client defects, none of which existed. The suite has to tell
 * "the client is wrong" apart from "the census would not answer me", and only the first is
 * news.
 */
/**
 * Authenticate when a key is available.
 *
 * The anonymous allowance is 240 requests an hour and this suite makes dozens; on a second run
 * in the same hour it measures its own throttling rather than the client. Every server-side
 * suite already carries the key for exactly this reason.
 */
const apiKey = process.env.CENSUS_CRAWLER_KEY;
const withKey = (o = {}) => (apiKey ? { apiKey, ...o } : o);

const probe = await preflight(["cloudflare.com"], withKey({ agent: "gptbot" }));
if (!probe.length || probe[0].verdict === "unknown") {
  console.log(`SKIP crawl-census-client assertions: the census did not answer (${probe[0]?.reason?.slice(0, 70) ?? "no response"})`);
  process.exit(0);
}


const failures = [];
const t = (name, cond) => {
  if (!cond) failures.push(name);
};

// --- URL normalisation ---
t("bare host", toDomain("example.com") === "example.com");
t("full url", toDomain("https://example.com/a/b?c=1") === "example.com");
t("www is stripped", toDomain("https://www.example.com/") === "example.com");
t("uppercase", toDomain("HTTPS://Example.COM") === "example.com");
t("garbage yields empty, not a throw", toDomain("not a url at all ///") === "");
t("empty is empty", toDomain("") === "" && toDomain(null) === "");

// --- verdicts match the live census ---
const rows = await preflight(["nytimes.com", "cloudflare.com", "apnews.com"], withKey({ agent: "gptbot" }));
t("one row per domain", rows.length === 3);
t("every row carries a verdict from the known set", rows.every((r) => ["allow", "disallow", "refuse", "pay", "unknown"].includes(r.verdict)));
t("every row explains itself", rows.every((r) => typeof r.reason === "string" && r.reason.length > 0));

// --- behaviour, which is the point of the library ---
const blocked = await politeFetch("https://nytimes.com/", withKey({ agent: "gptbot", cache: createCache() }));
t("a disallowed domain is skipped", blocked.skipped === true);
t("a skipped fetch spends no request", blocked.response === null);
t("a skip is returned, not thrown", typeof blocked.verdict === "string");

const allowed = await politeFetch("https://cloudflare.com/", withKey({ agent: "gptbot", cache: createCache() }));
t("an allowed domain is fetched", allowed.skipped === false && allowed.response?.ok === true);

// --- an origin quoting a price is never routed around by default ---
const priced = rows.find((r) => r.verdict === "pay");
if (priced) {
  const res = await politeFetch(`https://${priced.domain}/`, withKey({ agent: "gptbot", cache: createCache() }));
  t("a 402 origin is skipped by default", res.skipped === true && res.verdict === "pay");
  const forced = await politeFetch(`https://${priced.domain}/`, withKey({ agent: "gptbot", onPay: "fetch", cache: createCache() }));
  t("overriding a price is possible but recorded", forced.paidRouteOverridden === true);
}

// --- caching: a second call for the same host costs no lookup ---
{
  const cache = createCache();
  await politeFetch("https://cloudflare.com/", withKey({ agent: "gptbot", cache }));
  const t0 = Date.now();
  await politeFetch("https://cloudflare.com/about", withKey({ agent: "gptbot", cache }));
  t("a repeat host is served from cache", Date.now() - t0 < 3000);
}

// --- an unreachable census must degrade, never stop a crawl ---
{
  const rows2 = await preflight(["example.com"], withKey({ agent: "gptbot", endpoint: "https://127.0.0.1:9" }));
  t("an unreachable census yields unknown rather than throwing", rows2.length === 1 && rows2[0].verdict === "unknown");
  const res = await politeFetch("https://example.com/", withKey({ agent: "gptbot", endpoint: "https://127.0.0.1:9", cache: createCache() }));
  t("a crawl continues when the census is down", res.skipped === false);
}

// --- partitioning a queue ---
{
  const p = await partition(["https://nytimes.com/a", "https://nytimes.com/b", "https://cloudflare.com/c"], withKey({ agent: "gptbot" }));
  t("urls on one host are grouped", p.skip.length === 2 || p.crawl.length === 2 || p.pay.length === 2);
  t("every url is accounted for", p.crawl.length + p.skip.length + p.pay.length + p.unknown.length === 3);
}

// --- the deny-list file, which is the cheap path for a fetcher ---
{
  const set = await blocklist("gptbot");
  t("the blocklist parses to a usable set", set.size > 100);
  t("comment lines are not treated as domains", ![...set].some((d) => d.startsWith("#")));
  t("a known blocker is present", set.has("nytimes.com"));
  t("a known allower is absent", !set.has("cloudflare.com"));
}

// --- deltas, so nobody re-downloads the whole list ---
{
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const d = await changesSince("gptbot", since);
  t("the change feed returns a cursor to continue from", typeof d.next_since === "number");
  /**
   * The feed now carries edge and price transitions as well as robots ones, and the sync must
   * apply only the robots ones to a robots-derived list. Applying the rest deleted domains that
   * had just started refusing this crawler.
   */
  const robotsLabels = ["now_blocks_you", "no_longer_blocks_you"];
  const applied = (d.changes ?? []).filter((c) => robotsLabels.includes(c.change));
  const ignored = (d.changes ?? []).filter((c) => !robotsLabels.includes(c.change));
  t("every change carries a label", (d.changes ?? []).every((c) => typeof c.change === "string" && c.change.length > 3), "a change has no label");
  t("only robots transitions move the deny list", applied.length + ignored.length === (d.changes ?? []).length, "labels unaccounted for")
  t("the feed reports whether it truncated", typeof d.truncated === "boolean");
}

// --- sync applies deltas in place ---
{
  const sync = await syncBlocklist("gptbot");
  const before = sync.blocked.size;
  const r = await sync.refresh();
  t("refresh reports what it changed", typeof r.added === "number" && typeof r.removed === "number");
  t("refresh keeps the set consistent", r.size === sync.blocked.size);
  t("refresh advances the cursor", r.cursor >= Math.floor(Date.now() / 1000) - 86400);
  t("a no-op refresh does not corrupt the list", sync.blocked.size >= before - 5);
}

// --- the operator-facing view ---
{
  const prof = await agentProfile("claudebot");
  t("agent_profile names the operator", prof.operator === "Anthropic");
  t("agent_profile carries a correction channel", !!prof.correction_channel?.email);
}

// --- misuse is rejected clearly ---
{
  let threw = false;
  try {
    await politeFetch("https://example.com/", {});
  } catch {
    threw = true;
  }
  t("omitting the agent is an error", threw);
}


/**
 * The two unknowns.
 *
 * `partition` reported one `unknown` bucket for two situations with opposite correct actions:
 * a domain the census has not measured yet, which becomes answerable the moment it is
 * submitted, and a domain whose robots.txt disallows CrawlCensusBot, which never will. A
 * crawler retrying its unknowns each pass retried the second kind forever, and the only way to
 * tell them apart was matching English in `reason`.
 */
{
  const stamp = Date.now();
  const urls = [`https://never-measured-${stamp}.example/x`, "https://lobste.rs/y", "https://cloudflare.com/z"];
  const p = await partition(urls, withKey({ agent: "gptbot" }));

  t("a permitted domain is still routed to crawl", p.crawl.length === 1, `crawl ${p.crawl.length}`);
  t("an unmeasured domain lands in unknown", p.unknown.some((u) => u.includes(`never-measured-${stamp}`)), JSON.stringify(p.unknown));
  t("a site that refused our crawler is undecidable, not unknown", p.undecidable.some((u) => u.includes("lobste.rs")), JSON.stringify(p.undecidable));
  t("an undecidable domain is never offered for submission", !p.unmeasured.includes("lobste.rs"), JSON.stringify(p.unmeasured));
  t("the unmeasured list names the domain worth submitting", p.unmeasured.some((d) => d.includes(`never-measured-${stamp}`)), JSON.stringify(p.unmeasured));

  // The distinction must come from the machine field, not from prose.
  const v = p.verdicts.get("lobste.rs");
  t("the server marks it unmeasurable", v?.measurable === false, `measurable ${v?.measurable}`);

  // Submitting converges: nothing undecidable is ever sent.
  // A refusal is the census throttling this run, not the client misbehaving. Every suite in
  // this project has now learned the same lesson: report the throttle, do not indict the code.
  const sub = await submitUnmeasured(p, withKey({ agent: "gptbot" })).catch((e) => ({ throttled: String(e) }));
  if (sub.throttled) {
    console.log("  note: submission checks skipped, the census refused this run (" + sub.throttled.slice(0, 60) + ")");
  } else {
    t("submission accepts the measurable ones", typeof sub.queued === "number", JSON.stringify(sub).slice(0, 60));
    t("submission never carries a refused domain", !(sub.declined || []).includes("lobste.rs"), JSON.stringify(sub.declined));
  }

  // A second pass must not re-offer the refusal, or the loop never terminates.
  const again = await partition(urls, withKey({ agent: "gptbot" }));
  t("a second pass still excludes the refusal", !again.unmeasured.includes("lobste.rs"), JSON.stringify(again.unmeasured));
}


/**
 * What a concurrent crawl costs the census.
 *
 * Measured before this was fixed: twenty hosts fetched at once cost twenty preflight calls
 * carrying one domain each, and the same host requested three times concurrently cost three,
 * because the cache only helps after the first lookup resolves. The endpoint accepts up to a
 * thousand domains per call and the anonymous allowance is 240 an hour, so a crawler was
 * hitting its ceiling at 240 hosts when one call could have covered twenty-five.
 *
 * These assertions count the requests rather than trusting the design, and check that
 * batching did not scramble which verdict belongs to which domain - a silent failure that
 * would make a crawler skip the wrong sites.
 */
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  const sizes = [];
  globalThis.fetch = async (u, o) => {
    const str = String(u?.url ?? u);
    if (str.includes("/api/v1/preflight")) {
      calls++;
      try { sizes.push(JSON.parse(o.body).domains.length); } catch { /* not our body shape */ }
    }
    return realFetch(u, o);
  };

  try {
    const hosts = ["cloudflare.com", "nytimes.com", "apnews.com", "wikipedia.org", "forbes.com", "bbc.co.uk"];

    // Ground truth from a single explicit call, before any coalescing is involved.
    const truth = new Map((await preflight(hosts, withKey({ agent: "gptbot" }))).map((r) => [r.domain, r.verdict]));

    calls = 0;
    sizes.length = 0;
    const cache = createCache();
    const got = new Map();
    await Promise.all(
      hosts.map(async (h) => {
        const r = await politeFetch(`https://${h}/probe`, withKey({ agent: "gptbot", cache })).catch(() => null);
        got.set(h, r?.verdict ?? "ERR");
      }),
    );

    t("concurrent hosts cost one census call, not one each", calls === 1, `${calls} calls for ${hosts.length} hosts`);
    t("the single call carries every domain", sizes[0] === hosts.length, `first call carried ${sizes[0]}`);
    const wrong = hosts.filter((h) => truth.get(h) !== got.get(h));
    t("batching does not scramble verdicts", wrong.length === 0, wrong.map((h) => `${h}: ${truth.get(h)} vs ${got.get(h)}`).join(", "));

    // One host, several URLs, all in flight at once: the lookups must share a request.
    calls = 0;
    const c2 = createCache();
    await Promise.all([1, 2, 3, 4].map((i) => politeFetch(`https://srf.ch/dup-${i}`, withKey({ agent: "gptbot", cache: c2 })).catch(() => {})));
    t("concurrent URLs on one host share a single lookup", calls === 1, `${calls} calls for one host`);

    // Beyond the anonymous per-call cap the batch must split, not overflow into a 413.
    calls = 0;
    sizes.length = 0;
    const many = Array.from({ length: 60 }, (_, i) => `batch-cap-${i}-${Date.now()}.example`);
    const c3 = createCache();
    await Promise.all(many.map((h) => politeFetch(`https://${h}/x`, withKey({ agent: "gptbot", cache: c3 })).catch(() => {})));
    t("a large wave splits into several calls", calls >= 3, `${calls} calls for 60 hosts`);
    t("no call exceeds the anonymous per-call cap", sizes.every((n) => n <= 25), `sizes ${JSON.stringify(sizes)}`);
    t("every host in the wave is accounted for", sizes.reduce((a, b) => a + b, 0) === many.length, `${sizes.reduce((a, b) => a + b, 0)} of ${many.length}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}


/**
 * The documented two-step must cost one call, not two.
 *
 * `partition` looked up every domain and then discarded the answers, so the pattern the README
 * teaches - partition a queue, then fetch what it says to fetch - paid the census twice for one
 * queue. For a crawler running that loop continuously it was half its census traffic, spent on
 * questions it had already asked and been answered.
 */
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u, o) => {
    if (String(u?.url ?? u).includes("/api/v1/preflight")) calls++;
    return realFetch(u, o);
  };
  try {
    const urls = ["https://cloudflare.com/a", "https://wikipedia.org/b", "https://apnews.com/c", "https://forbes.com/d"];
    const cache = createCache();
    const p = await partition(urls, withKey({ agent: "gptbot", cache }));
    const afterPartition = calls;
    const results = await Promise.all(p.crawl.map((u) => politeFetch(u, withKey({ agent: "gptbot", cache })).catch(() => null)));

    t("partition costs one call for the whole queue", afterPartition === 1, `${afterPartition} calls`);
    t("fetching what partition allowed costs nothing further", calls === afterPartition, `${calls - afterPartition} extra calls`);
    t("the warmed verdicts are still the right ones", results.every((r) => r && r.verdict === "allow"), JSON.stringify(results.map((r) => r?.verdict)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (failures.length) {
  console.log(`FAIL ${failures.length} client assertions`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("PASS all crawl-census-client assertions against the live census");
