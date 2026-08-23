/**
 * Live tests against the public census.
 *
 * These deliberately hit the real service. The value of this client is entirely in whether its
 * verdicts match reality, and a mocked test would assert only that the mock was written to
 * agree with itself.
 *
 * Run: node test.mjs
 */
import { agentProfile, partition, politeFetch, preflight, toDomain, createCache } from "./index.mjs";

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

if (failures.length) {
  console.log(`FAIL ${failures.length} client assertions`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("PASS all crawl-census-client assertions against the live census");
