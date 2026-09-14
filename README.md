# Community-Span — Backend & Ingestion Pipeline

A content platform that watches the official YouTube channels of towns, cities,
counties and school districts, notices within seconds when one of them uploads a
meeting or goes live, tags it with civic topics, and serves it to the website.

Written for a non-developer to operate. Every command you need is in this file.

---

## What this actually does

```
    A town's clerk publishes a council meeting
                    │
                    ▼
    YouTube's WebSub hub pushes a notification    ← seconds, not polling
                    │
                    ▼
    POST /websub/youtube    (signature verified)
                    │
                    ▼
    YouTube Data API: title, description, runtime, live status
                    │
                    ▼
    Topic classifier: Budget & Taxes, Zoning & Housing, Public Safety …
                    │
                    ▼
    Postgres  ──────────────►  GET /api/videos  ──────────►  the website
                    ▲
                    │
    Daily job: renew subscriptions, catch anything missed,
               close out finished livestreams
```

**Nothing is polled.** YouTube tells us. Polling 500 channels every few minutes
would blow through the API quota by lunchtime; push notifications cost nothing.

---

## The stack, and why

| Piece | Choice | Why |
| --- | --- | --- |
| Server | Node.js + Express | Smallest possible thing that does the job. No build step, no framework to learn. |
| Database | Postgres (Supabase free tier) | Real relational database with full-text search built in. Free until you have real traffic. |
| Real-time | YouTube WebSub push | Instant, free, and quota-free. The alternative (polling) is neither. |
| Topic tagging | Keyword rules in the database | Free, instant, and explainable — every tag records exactly which words produced it. Tunable without a developer. |
| Hosting | Render (recommended) | Always-on, ~$7/mo, permanent HTTPS URL for the webhook, built-in daily cron. |

Total monthly cost to launch: **about $7**, plus $0 for Supabase and $0 for the
YouTube API until you are well past a few hundred channels.

---

## Setup — one hour, start to finish

### Step 1 — Get the code running on your own machine (10 min)

You need [Node.js 20 or newer](https://nodejs.org). Then:

```bash
npm install
cp .env.example .env
```

Open `.env` in any text editor. It explains every value inline. You need four:
`DATABASE_URL`, `YOUTUBE_API_KEY`, `WEBSUB_SECRET`, `ADMIN_TOKEN`, plus
`WEBSUB_VERIFY_TOKEN` and `PUBLIC_BASE_URL` once you deploy.

To generate the random secrets, run this three times and paste a different
result into each of `WEBSUB_SECRET`, `WEBSUB_VERIFY_TOKEN` and `ADMIN_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 2 — Create the database (10 min)

1. Go to [supabase.com](https://supabase.com), sign up, click **New project**.
2. Name it `community-span`. Choose a database password and **save it somewhere** —
   you cannot see it again.
3. Wait about two minutes while it provisions.
4. Go to **Project Settings → Database → Connection string → URI**. Copy it.
5. Paste it into `.env` as `DATABASE_URL`, replacing `[YOUR-PASSWORD]` with the
   password from step 2.

Then create the tables:

```bash
npm run migrate
```

You should see each migration apply. Safe to run again any time — it skips work
already done.

### Step 3 — Get a YouTube API key (10 min)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → search *YouTube Data API v3* → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Click the new key → **Restrict key** → under *API restrictions* choose
   **YouTube Data API v3**. Leave *Application restrictions* as **None** (this key
   is used from your server, not a browser).
5. Paste it into `.env` as `YOUTUBE_API_KEY`.

### Step 4 — Load the starter towns (2 min)

```bash
npm run seed
```

This loads **21 real municipal channels** already verified against their
published meetings — Palm Bay FL, Phoenix AZ, Corpus Christi TX, Chelmsford MA,
Glynn County GA, Bonner County ID, three Pennsylvania school districts, and more.
13 states, five kinds of governing body.

Then pull their recent meeting history so the site is not empty:

```bash
npm run backfill
```

*(No API key yet? Run `node scripts/seed-demo-videos.js` instead. It loads 35 real
meetings without touching the API, so you can see everything working first.)*

### Step 5 — Start it up (1 min)

```bash
npm start
```

Open <http://localhost:3000>. The site loads, filters work, and the badge in the
top bar reads **LIVE DATA** — meaning it is reading your database, not sample data.

Check the API directly if you like:

```bash
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/videos?state=TX&topic=budget-taxes"
```

### Step 6 — Deploy so YouTube can reach you (15 min)

Real-time push only works once the server has a public HTTPS address.

1. Push this folder to a new **private** GitHub repository.
2. Go to [render.com](https://render.com) → **New + → Blueprint** → connect the repo.
   Render reads `render.yaml` and creates both the web service and the daily cron job.
3. In the service's **Environment** tab, paste in `DATABASE_URL`,
   `YOUTUBE_API_KEY`, `WEBSUB_SECRET`, `WEBSUB_VERIFY_TOKEN` and `ADMIN_TOKEN`.
   Render fills in `PUBLIC_BASE_URL` automatically.
4. Wait for the first deploy. Confirm it is alive:

```bash
curl https://your-service.onrender.com/api/health
```

> **Use the Starter plan, not Free.** Render's free tier puts the service to
> sleep when idle. A sleeping server misses push notifications, and after enough
> failures YouTube's hub drops your subscription entirely.

### Step 7 — Turn on real-time push (2 min)

With the server live, from your own machine (with `PUBLIC_BASE_URL` in `.env` set
to the Render URL):

```bash
npm run subscribe
```

You will see one line per channel. Within seconds, YouTube's hub calls your
server back to verify each subscription. Confirm they took:

```bash
curl https://your-service.onrender.com/api/channels | grep -o '"websub_state":"[a-z]*"' | sort | uniq -c
```

You want to see `active`. `pending` means the hub has not called back yet — wait a
minute. `failed` means your URL was not reachable; re-check `PUBLIC_BASE_URL`.

**That is it.** The next time any of those 21 towns publishes a meeting, it
appears on your site within seconds, already tagged.

---

## Adding a town

The whole business depends on this being easy, so it is one command. Paste a
channel URL, an `@handle`, or a link to *any* video on the channel:

```bash
npm run add-channel -- "https://www.youtube.com/@CityofAustin" "Austin" "Travis County" TX "Texas" "City Council" 975000
```

Arguments in order: channel, municipality, county, two-letter state, state name,
governing body, population. It resolves the channel, saves it, subscribes to push
notifications, and pulls the last 15 meetings — all in one go.

Or over HTTP, if you would rather build an admin screen later:

```bash
curl -X POST https://your-service.onrender.com/admin/channels \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"channel":"https://www.youtube.com/@CityofAustin","municipality":"Austin",
       "county":"Travis County","stateCode":"TX","stateName":"Texas",
       "govBody":"City Council","population":975000}'
```

For bulk loading, add rows to `db/seed-channels.json` and run `npm run seed`.

---

## How topic tagging works

Nine civic topics ship out of the box: **Zoning & Housing, Budget & Taxes,
Public Safety, Infrastructure, Public Comment, Schools & Education,
Water & Environment, Parks & Recreation, Open Government**, plus a
**General Session** catch-all for full mixed-agenda meetings.

Each topic owns a list of weighted keyword phrases in the `topic_rules` table.
A meeting's title, description and YouTube tags are scored against all of them.
Title matches count triple — municipal clerks write precise titles, and
"Budget Work Session" tells you far more than the same phrase buried in
paragraph nine of a description.

Two refinements worth knowing about:

- **The governing body is evidence.** A School Board meeting is about schools even
  when the title says only "School Board Meeting 4/13". The `gov_body_topics`
  table encodes that, at deliberately modest weight so real agenda text always wins.
- **Nothing goes untagged.** A meeting that matches nothing lands in
  General Session rather than vanishing from every topic filter.

**Every tag records why it was applied.** The `matched_terms` column stores the
exact phrases that fired. For a platform whose promise is "no editing, commentary
or analysis", being able to show your work is the point.

### Topic coverage: the honest picture

This matters more than any other line in this file, so read it before you demo
the topic filter to anyone.

Of the 35 seeded meetings, **9 carry a specific subject tag. The other 26 are
filed under General Session.** That is not a bug in the filter — it is the
source data. Most towns title a video "City Council Meeting - August 11, 2026"
and fill the description with vendor boilerplate about technical difficulties.
There is genuinely nothing in there that says what was discussed.

Where titles *are* descriptive, tagging is excellent. Planning and zoning
hearings, school boards, budget hearings and public hearings tag correctly and
consistently, because clerks name those meetings after their subject.

An early version of this classifier looked better than this and was worse. It
tagged meetings "Open Government" because the description mentioned "agendas,
minutes and meeting videos" — boilerplate on every video the city posts. For a
platform promising no editing, commentary or analysis, a confidently wrong
subject tag is a bigger problem than an honestly generic one. So the rule now
encoded is: **a term earns a topic only if it describes what was discussed,
never merely that a meeting happened or that records exist.**

To get genuinely rich topics across a national footprint, you need the agenda,
not the YouTube description. Ranked by practicality:

1. **Agenda ingestion per platform.** Most towns publish agendas through one of
   about six vendors — Granicus/Legistar, CivicClerk, CivicPlus, PrimeGov,
   AgendaSuite, Novus. Each has predictable URL patterns and several have public
   JSON APIs. This is the real fix and it is free, but it is a per-vendor
   integration project, not an afternoon. Some also block automated fetching, so
   expect to handle each one differently.
2. **Timestamped chapters in descriptions.** Some channels list agenda items with
   timecodes. Where present this is free, precise, and doubles as a "jump to the
   rezoning item" feature. None of the 23 real descriptions in this seed set had
   them, so treat it as a bonus, not a strategy.
3. **Paid transcripts.** Works, reads what was actually said, and costs per video
   — which stings on six-hour meetings.

Until one of those lands, be straightforward in the product about what the tags
mean. The home page states the coverage ratio under the topic module and shows
uncovered topics greyed out rather than hiding them.

### Agenda ingestion (Legistar + PrimeGov)

This is the fix for thin topic coverage, and it is live.

**Neither vendor charges you anything.** Both publish agendas over plain public
HTTP with no key, because these are public records and the town has already paid
the vendor. Verified by direct request:

| Vendor | Endpoint | What you get |
| --- | --- | --- |
| Legistar (Granicus) | `webapi.legistar.com/v1/{client}/events/{id}/eventitems` | Fully structured agenda items, including ordinance text |
| PrimeGov | `{client}.primegov.com/api/v2/PublicPortal/ListUpcomingMeetings` | Meeting list as JSON; the agenda itself as a public PDF |

What it does to tagging. Phoenix's April 22 council meeting has a bare title, so
it used to be General Session. Matched to its 78-item agenda it now tags
Infrastructure, Zoning & Housing, Parks & Recreation and Water & Environment — on
the evidence "affordable housing, land use, rezoning, zoning", pulled from the
city's own agenda. Corpus Christi's May 5 meeting matched a 48-item agenda.

Commands:

```bash
npm run discover              # build the catalogue of readable towns
npm run discover -- legistar  # one vendor only
npm run agendas               # pull agendas, match to videos, re-tag
```

The daily job runs the sync and match stages automatically, wrapped so that an
agenda vendor having a bad day cannot fail the rest of the safety net.

**How matching works.** A video and an agenda are the same meeting when they
belong to the same town, land on the same calendar day (one day either side, for
streams that cross midnight), and their body names agree. If no agenda is on file
for that date, the matcher makes one targeted request for that week rather than
pulling a town's entire history. Nothing is matched on a guess, and every match
is recorded on the video with a timestamp.

**Tag provenance.** Tags now carry a `source` of `agenda`, `transcript` or
`metadata`, and the API exposes it. An agenda-backed tag is one you can defend.

### Picking new towns from a list

Neither vendor publishes a customer directory, so `npm run discover` builds one.
For Legistar it probes likely client codes derived from US city and county names;
for PrimeGov it starts from tenant subdomains found in public certificate
transparency logs. Anything that answers with real meeting data is catalogued.

Two notes from building this. Legistar answers **500**, not 404, for a client code
that does not exist — so a naive probe records a mountain of junk. And when a town
returns 401 or 403 we *do* record it: that means the town exists but has gated its
API behind a token, which is useful to know if you ever want to approach them.

Browse the catalogue:

```bash
curl "$PUBLIC_BASE_URL/api/agenda-sources?q=austin"
curl "$PUBLIC_BASE_URL/api/agenda-sources?vendor=primegov&available_only=true"
```

Then add a town by picking an entry, supplying only its YouTube channel and
location:

```bash
curl -X POST "$PUBLIC_BASE_URL/admin/channels/from-agenda-source" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"vendor":"legistar","clientCode":"denver",
       "channel":"https://www.youtube.com/@DenverCityCouncil",
       "municipality":"Denver","county":"Denver County",
       "stateCode":"CO","stateName":"Colorado",
       "govBody":"City Council","population":715000}'
```

That one call resolves the channel, links the agenda source, subscribes to
real-time push, and pulls the agendas. To attach an agenda source to a town you
are already monitoring, `POST /admin/channels/:ytChannelId/agenda-source`.

**Coverage reality check.** Legistar skews large — Granicus says Legistar serves
[half of the largest US cities and counties](https://granicus.com/), and of the 21
towns seeded here only Corpus Christi and Phoenix are on it. PrimeGov is smaller
still, around [180 local government agencies](https://www.privsource.com/). So
agenda ingestion transforms coverage for big cities and does nothing for a New
England town that posts a PDF to its own website. Columbia SC is on CivicClerk,
whose API is also open — that is the obvious next adapter.

### Adding a new kind of governing body

Tagging hints are keyed on the `gov_body` value you give a channel, normalised
for case, spacing and "and" vs "&". About 40 body names are pre-mapped — Board
of Education, School Committee, Zoning Board of Appeals, Conservation
Commission, Finance Committee, Police Commission and so on — so new feeds
inherit sensible tagging with no code change.

General-purpose bodies (City Council, Select Board, County Commission, Board of
Supervisors, Town Council) deliberately get **no** hint. Their agendas are mixed,
so any subject we assigned would be a guess.

If you add a single-purpose body that is not yet mapped, `npm run add-channel`
prints a warning telling you so, plus the exact SQL to map it. Add the row, then
call `/admin/reclassify`.

### Tuning it without a developer

Add a keyword:

```sql
INSERT INTO topic_rules (topic_id, term, weight)
SELECT id, 'short term rental', 2.5 FROM topics WHERE slug = 'zoning-housing';
```

Then re-tag the library:

```bash
curl -X POST https://your-service.onrender.com/admin/reclassify \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"limit":2000}'
```

If tags feel too noisy, raise `TOPIC_SCORE_THRESHOLD`. Too sparse, lower it.

### About transcripts

You asked about pulling transcripts. Here is the honest constraint: **YouTube's
Data API only lets you download captions for channels your own Google account
owns.** There is no legitimate API route to transcripts for other towns' videos.

So launch tagging reads titles, descriptions and tags — which for municipal
meetings is unusually good signal. `server/lib/transcript.js` is a ready slot for
a provider when you want to tag from what was actually said; the classifier
already weights transcripts and records `source='transcript'` on those tags.
When that day comes, also consider parsing the agenda and minutes PDFs most towns
publish: free, unambiguously legal, and often better signal than a raw transcript.

---

## The API the website uses

| Route | What it gives you |
| --- | --- |
| `GET /api/health` | Service and database status. Render's health check uses this. |
| `GET /api/topics` | Topics with live video counts, for the "Top community topics" module. |
| `GET /api/filters` | Every dropdown's options — states, counties, cities, bodies, size tiers — in one request. |
| `GET /api/videos` | The main query. See parameters below. |
| `GET /api/videos/:id` | One meeting. |
| `GET /api/channels` | Monitored channels plus subscription health. |
| `GET /api/stats` | Headline numbers for the site and the last job run. |

`GET /api/videos` parameters, all optional and combinable:

| Parameter | Example | Notes |
| --- | --- | --- |
| `topic` | `budget-taxes` or `budget-taxes,public-safety` | Comma-separated list matches any |
| `state` | `TX` | Two-letter code |
| `county` | `Lubbock County` | |
| `city` | `Lubbock` | |
| `body` | `School Board` | |
| `tier` | `xs` `sm` `md` `lg` `xl` | Community size band |
| `status` | `live` · `live,upcoming` · `recorded` | |
| `q` | `stormwater` | Full-text over title and description, plus place names |
| `sort` | `newest` `oldest` `longest` `shortest` `population-desc` `population-asc` `town` | |
| `limit` / `offset` | `24` / `0` | `limit` caps at 100 |

Example — every live or upcoming zoning hearing in Texas, biggest towns first:

```
/api/videos?state=TX&topic=zoning-housing&status=live,upcoming&sort=population-desc
```

Responses are camelCase and stable, so the front end never touches SQL column
names. Admin routes live under `/admin/*` behind `ADMIN_TOKEN`.

---

## The daily safety net

Push notifications are fast but not guaranteed. Four things go wrong in practice,
and `npm run daily` fixes all four:

1. **Subscriptions expire.** Leases last about 9.6 days. Nothing renews them on its
   own, and the failure is silent — the feed just goes quiet for a week.
2. **Pushes get missed.** Deploys, restarts and hub hiccups drop notifications, so
   the job reads each channel's uploads playlist and ingests anything new.
3. **Livestreams go stale.** A stream marked live stays live in the database until
   re-checked, so the site would badge a meeting that ended on Tuesday as LIVE.
4. **Cancelled streams get stuck** in "upcoming" forever.

Render's blueprint already schedules this at 08:00 UTC. Every run writes a row to
`job_runs`, so you can prove the pipeline is healthy:

```bash
curl https://your-service.onrender.com/admin/job-runs \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

---

## Adding towns without a terminal

Open **`/admin.html`** on your running server (for example
`https://your-service.onrender.com/admin.html`) and paste your `ADMIN_TOKEN`
to unlock it. The token is held in the browser tab's memory only — it is never
written to storage and never sent anywhere except your own server. Close the
tab and it is gone.

The screen does four things:

1. **Look up a channel.** Paste a channel URL, an `@handle`, or a link to any
   meeting video. It shows you the channel name and its most recent uploads so
   you can confirm these really are meetings before you commit — nothing is
   saved at this stage.
2. **Say where it is.** City, county, state, governing body, population. These
   stay manual on purpose: no catalogue can tell you whether a given channel is
   really a particular town's select board. The governing-body picker explains
   whether your choice carries a default topic hint.
3. **Optionally attach an agenda source.** As you type the town name, the
   screen searches the agenda catalogue and offers any match. Most towns will
   have none, and it says so plainly. You can attach one later without redoing
   anything.
4. **Save.** One click resolves the channel, subscribes to real-time push, pulls
   the last 15 meetings, and links the agenda source if you chose one.

Below that, **Paste from a spreadsheet** takes many towns at once — copy rows
straight out of Google Sheets or Excel (tabs and commas both work) in the order
`channel, municipality, county, stateCode, stateName, govBody, population`.
Every row is reported back individually, so one bad line never sinks the batch.

The **Your towns** table shows every monitored community with whether real-time
push is confirmed, whether it has an agenda source, how many meetings are on
file, and how recent the latest one is. Per-row buttons re-pull a town's recent
meetings or re-subscribe it if push has lapsed.

This page is deliberately **not** linked from the public site navigation. It is
an internal tool; the only way in is to know the URL and hold the token.

### After running the tests

`npm test` drives the real pipeline against a stubbed YouTube API — that is what
makes the tests worth having, but it also means the reconcile stage refreshes
your live and upcoming videos and they come back wearing the stub's title. Run:

```bash
npm run restore-demo   # real titles back, test rows removed, then verifies
npm run agendas        # re-match agendas
```

`restore-demo` fails loudly if any title is duplicated or any stub title
survives, so you never present stale demo data by accident.

### The three ways to add a town

| Route | Best for |
| --- | --- |
| `/admin.html` | Day-to-day work. No terminal needed. |
| `npm run add-channel -- "<url>" "<Town>" "<County>" ST "<State>" "<Body>" <pop>` | Scripting, or a one-off from a server shell. |
| `db/seed-channels.json` + `npm run seed` | The initial roster, and rebuilding a fresh database. |

All three write the same rows, so you can mix them freely.

## API quota, in plain numbers

Google gives you 10,000 units a day free.

| Operation | Cost | When |
| --- | --- | --- |
| `videos.list` (up to 50 videos) | 1 unit | Every push notification, and live refreshes |
| `playlistItems.list` | 1 unit | Once per channel in the daily backfill |
| `channels.list` | 1 unit | Once when a channel is added |
| `search.list` | **100 units** | Never — deliberately unused |

At 200 monitored channels: about 200 units for the daily backfill, plus a handful
per new meeting. Call it 300-400 units a day — **under 4% of the free allowance**.
That single design decision (push, never poll; never call `search.list`) is what
keeps this free at real scale.

---

## Running the tests

```bash
node test/pg-server.mjs 55432   # a throwaway Postgres, in one terminal
npm test                        # in another
```

39 checks covering every API filter and sort, the WebSub handshake, signature
rejection, end-to-end ingestion, duplicate suppression, deleted-video handling,
subscription renewal windows, stale-livestream cleanup, and admin authentication.
They run the real Express app against the real schema over real HTTP.

---

## Troubleshooting

**Site shows "SAMPLE DATA" instead of "LIVE DATA"**
The page could not reach the API, so it fell back to the bundled sample library
rather than showing an empty screen. Check `curl <your-url>/api/health`.

**`websub_state` stuck on `pending`**
The hub could not reach your callback. Confirm `PUBLIC_BASE_URL` is the exact
public HTTPS URL with no trailing slash, that the service is awake (not on
Render's free tier), and that `curl <PUBLIC_BASE_URL>/api/health` works from
outside your network.

**Meetings stopped appearing**
Almost always an expired lease. Run `npm run daily` and check `/admin/job-runs`.

**`YouTube API quota exceeded`**
Quota resets at midnight Pacific. Lower `BACKFILL_PER_CHANNEL`, or request a
quota increase in Google Cloud once you are past a few hundred channels.

**A push arrived but nothing appeared**
The channel is probably not in your `channels` table — unknown channels are
skipped on purpose. Check `/admin/websub-events` to see what arrived and why it
was skipped.

**`too many clients already`**
Your Postgres plan's connection cap. Lower `DB_POOL_MAX`, or switch
`DATABASE_URL` to Supabase's pooler string (port 6543).

---

## What is real and what is a placeholder

Real and working: the 21 municipal channels, all ingested video, live and upcoming
detection, topic tagging, every filter and sort, the WebSub pipeline, the daily
job, the whole API.

Still placeholders on the home page: the two advertising units and the
"Community star of the week" module. Both are marked as such in the footer.

---

## File map

```
server/
  index.js              app bootstrap, route mounting, graceful shutdown
  config.js             every environment variable, declared in one place
  db.js                 Postgres pool, query helpers, transactions
  routes/api.js         the public read API
  routes/admin.js       token-protected maintenance routes
  websub/router.js      GET verification + signed POST notifications
  websub/subscribe.js   subscribe, renew, unsubscribe, lease bookkeeping
  pipeline/ingest.js    metadata fetch -> classify -> upsert
  pipeline/classify.js  the topic scoring engine
  pipeline/reconcile.js the daily safety net
  lib/youtube.js        Data API client, quota-aware
  lib/transcript.js     the (empty by design) transcript slot
db/
  migrations/           001 schema · 002 topics+rules · 003 body hints · 004 trending flag\n                        005 fallback topic · 006 drop boilerplate rules · 007 body aliases\n                        008 agenda ingestion\n  agenda-candidates.json  684 Legistar candidate codes + 116 PrimeGov tenants\nserver/lib/agenda/       legistar.js · primegov.js · pdf.js · index.js (registry)\nserver/pipeline/agenda.js  discovery, sync, video-to-agenda matching
  seed-channels.json    21 real municipal channels
  seed-videos.json      35 real meetings, for demoing without an API key
scripts/
  migrate.js  seed-channels.js  add-channel.js  subscribe.js
  daily.js    backfill.js       seed-demo-videos.js
public/                 the website, wired to the API with a sample-data fallback
test/                   the 39-check suite and its throwaway Postgres
render.yaml             one-click Render deploy: web service + daily cron
```
