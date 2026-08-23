# crawl-census-client

**Ask before you fetch.** A drop-in client that stops your crawler spending requests on doors
that are shut, and stops it routing around content someone is trying to sell.

Reading robots.txt answers one question and hides two others. Measured across **23,482 domains**
by [Crawl Census](https://crawlcensus.com):

- **2,874 domains permit AI agents in robots.txt and then refuse those same agents at the
  network edge.** A parser sees permission; the fetch returns 403. You pay for the round trip
  and get nothing.
- **208 domains answer an AI user agent with `HTTP 402 Payment Required`.** That is a price,
  not a refusal. Treating it as a block walks away from content the operator wants to sell you.
  Retrying around it takes something they are charging for.

No dependencies. No key required.

## MCP server

The same measurement is exposed as a remote MCP server, so an agent can ask before it fetches
rather than after it fails. Listed in the
[official MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.taylorsmithgg/crawl-census`.

```json
{ "mcpServers": { "crawl-census": { "url": "https://crawlcensus.com/mcp" } } }
```

| Tool | Answers |
|---|---|
| `crawl_preflight` | will these domains serve my agent, refuse it, or charge it? |
| `agent_profile` | what does this census publish about my crawler, and how do I correct it? |
| `census_facts` | the headline findings as dated records with denominators and citation lines |
| `site_report` | the stored audit for one domain |
| `scan_site` | measure a domain now |
| `census_stats` | corpus-level totals |

No authentication for read tools. Streamable HTTP.

## Install

```bash
npm i github:taylorsmithgg/crawl-census-client
pip install git+https://github.com/taylorsmithgg/crawl-census-client
```

## Use

```js
import { politeFetch } from "crawl-census-client";

const r = await politeFetch("https://example.com/", { agent: "gptbot" });
if (r.skipped) console.log(r.verdict, r.reason);   // disallow | refuse | pay
else           process(await r.response.text());
```

```python
from crawl_census import polite_fetch

r = polite_fetch("https://example.com/", agent="gptbot")
if r.skipped:
    print(r.verdict, r.reason)
else:
    process(r.body)
```

Skipping is returned, not raised. It is the normal outcome for a large share of the web, and a
crawl loop should be able to count skips without a try/except around every URL.

## Split a queue before crawling it

One call per 1,000 domains instead of one per host:

```js
const { crawl, skip, pay, unknown } = await partition(urls, { agent: "gptbot" });
```

```python
p = partition(urls, agent="gptbot")
p.crawl, p.skip, p.pay, p.unknown
```

## Or just take the file

For a fetcher that only needs a deny list in memory, skip the per-domain calls entirely:

```bash
curl https://crawlcensus.com/agents/gptbot/blocklist.txt   # one domain per line, commented header
```

```js
const sync = await syncBlocklist("gptbot");   // full list once
if (sync.blocked.has(host)) skip();
setInterval(() => sync.refresh(), 3600_000);  // then deltas only, a few hundred bytes
```

```python
sync = BlocklistSync("gptbot")
if host in sync: skip()
sync.refresh()          # {'added': 3, 'removed': 1, 'size': 3310, 'cursor': ...}
```

The delta feed is `https://crawlcensus.com/agents/<agent>/changes.json?since=<unix>` and each
response carries `next_since`, so a long-running crawler stays current on a few hundred bytes
an hour instead of re-downloading the list.

That file covers **robots.txt only**. Edge refusal and HTTP 402 are per-request behaviours and
still need `preflight` or `politeFetch`.

## Keeping a deny list current

`syncBlocklist` / `BlocklistSync` download the list once, then apply only what changed.

The list is served with the exact position in the change feed it was built at, in an
`x-cursor` header and a `# cursor:` comment. The clients read it and resume from there, so
there is no gap between the snapshot and the first poll, and no reliance on your clock being
in step with the server's. Polling by second cannot express a position inside a second, and a
crawl batch writes dozens of events into one, so a second-granularity resume can drop the
remainder of it: measured live, resuming after the first of three same-second changes
recovered both siblings by cursor and neither by second.

```js
const sync = await syncBlocklist("gptbot");   // cursor comes from the list itself
if (sync.blocked.has(host)) skip();
setInterval(() => sync.refresh(), 3600_000);  // a few hundred bytes per poll
```

## Verdicts

| Verdict | Meaning | Default behaviour |
|---|---|---|
| `allow` | robots.txt permits this agent, and a live request carrying its user agent was served | fetch |
| `disallow` | robots.txt forbids this agent at the site root | skip |
| `refuse` | robots.txt permits it; the edge refused it anyway. The allowance is not real | skip |
| `pay` | the origin answered HTTP 402. It will serve this agent on commercial terms | skip |
| `unknown` | not measured recently enough to answer | fetch |

`onPay: "fetch"` (`on_pay="fetch"`) overrides the paywall default. It is an explicit opt-in and
is recorded on the result as `paidRouteOverridden` so it shows up in your logs.

## It degrades, it does not fail

If the census is unreachable every verdict becomes `unknown` and your crawl proceeds as it
normally would. A third-party outage must never stop your pipeline. There is a live test for
exactly this.

## What we publish about your agent

```js
const p = await agentProfile("claudebot");
// robots disallow rate, edge refusal rate, operator page, correction channel
```

If a figure is wrong, the correction channel is in that response and on your
[operator page](https://crawlcensus.com/operators). Registry facts are corrected without
argument; disputed measurements are published alongside the dispute with the underlying scan
records, rather than quietly amended.

## Limits

25 domains per preflight call anonymously, 200 with a Pro key, 1,000 with a Data key. Pass
`apiKey`. Details at <https://crawlcensus.com/for-crawlers>.

## Tests

`node test.mjs` runs against the live census on purpose. The value of this client is whether
its verdicts match reality, and a mocked test would assert only that the mock agrees with itself.

MIT. Data is CC BY 4.0, attribute as "Source: Crawl Census (crawlcensus.com)".
