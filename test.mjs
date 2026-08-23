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
const rows = await preflight(["nytimes.com", "cloudflare.com", "apnews.com"], { agent: "gptbot" });
t("one row per domain", rows.length === 3);
t("every row carries a verdict from the known set", rows.every((r) => ["allow", "disallow", "refuse", "pay", "unknown"].includes(r.verdict)));
t("every row explains itself", rows.every((r) => typeof r.reason === "string" && r.reason.length > 0));

// --- behaviour, which is the point of the library ---
const blocked = await politeFetch("https://nytimes.com/", { agent: "gptbot", cache: createCache() });
t("a disallowed domain is skipped", blocked.skipped === true);
t("a skipped fetch spends no request", blocked.response === null);
t("a skip is returned, not thrown", typeof blocked.verdict === "string");

const allowed = await politeFetch("https://cloudflare.com/", { agent: "gptbot", cache: createCache() });
t("an allowed domain is fetched", allowed.skipped === false && allowed.response?.ok === true);

// --- an origin quoting a price is never routed around by default ---
const priced = rows.find((r) => r.verdict === "pay");
if (priced) {
  const res = await politeFetch(`https://${priced.domain}/`, { agent: "gptbot", cache: createCache() });
  t("a 402 origin is skipped by default", res.skipped === true && res.verdict === "pay");
  const forced = await politeFetch(`https://${priced.domain}/`, { agent: "gptbot", onPay: "fetch", cache: createCache() });
  t("overriding a price is possible but recorded", forced.paidRouteOverridden === true);
}

// --- caching: a second call for the same host costs no lookup ---
{
  const cache = createCache();
  await politeFetch("https://cloudflare.com/", { agent: "gptbot", cache });
  const t0 = Date.now();
  await politeFetch("https://cloudflare.com/about", { agent: "gptbot", cache });
  t("a repeat host is served from cache", Date.now() - t0 < 3000);
}

// --- an unreachable census must degrade, never stop a crawl ---
{
  const rows2 = await preflight(["example.com"], { agent: "gptbot", endpoint: "https://127.0.0.1:9" });
  t("an unreachable census yields unknown rather than throwing", rows2.length === 1 && rows2[0].verdict === "unknown");
  const res = await politeFetch("https://example.com/", { agent: "gptbot", endpoint: "https://127.0.0.1:9", cache: createCache() });
  t("a crawl continues when the census is down", res.skipped === false);
}

// --- partitioning a queue ---
{
  const p = await partition(["https://nytimes.com/a", "https://nytimes.com/b", "https://cloudflare.com/c"], { agent: "gptbot" });
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
  t("every change names a direction an operator can act on", (d.changes ?? []).every((c) => ["now_blocks_you", "no_longer_blocks_you"].includes(c.change)));
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
  const p = await partition(urls, { agent: "gptbot" });

  t("a permitted domain is still routed to crawl", p.crawl.length === 1, `crawl ${p.crawl.length}`);
  t("an unmeasured domain lands in unknown", p.unknown.some((u) => u.includes(`never-measured-${stamp}`)), JSON.stringify(p.unknown));
  t("a site that refused our crawler is undecidable, not unknown", p.undecidable.some((u) => u.includes("lobste.rs")), JSON.stringify(p.undecidable));
  t("an undecidable domain is never offered for submission", !p.unmeasured.includes("lobste.rs"), JSON.stringify(p.unmeasured));
  t("the unmeasured list names the domain worth submitting", p.unmeasured.some((d) => d.includes(`never-measured-${stamp}`)), JSON.stringify(p.unmeasured));

  // The distinction must come from the machine field, not from prose.
  const v = p.verdicts.get("lobste.rs");
  t("the server marks it unmeasurable", v?.measurable === false, `measurable ${v?.measurable}`);

  // Submitting converges: nothing undecidable is ever sent.
  const sub = await submitUnmeasured(p, { agent: "gptbot" });
  t("submission accepts the measurable ones", typeof sub.queued === "number", JSON.stringify(sub).slice(0, 60));
  t("submission never carries a refused domain", !(sub.declined || []).includes("lobste.rs"), JSON.stringify(sub.declined));

  // A second pass must not re-offer the refusal, or the loop never terminates.
  const again = await partition(urls, { agent: "gptbot" });
  t("a second pass still excludes the refusal", !again.unmeasured.includes("lobste.rs"), JSON.stringify(again.unmeasured));
}

if (failures.length) {
  console.log(`FAIL ${failures.length} client assertions`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("PASS all crawl-census-client assertions against the live census");
