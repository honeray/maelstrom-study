# Data and privacy

## What is public and what is private

| Thing | Visibility |
|---|---|
| The site (HTML, CSS, JS, survey questions) | Public — required for GitHub Pages |
| `reports/` (summary reports you publish) | Public by design |
| Participants' answers | **Private** — a separate private repository |
| The GitHub token that writes them | Secret, held only by the Cloudflare Worker |
| The Cloudflare admin token | Secret, used only for a manual flush |

Nothing in the public site can read or write the data repository: the browser never holds
a GitHub token. This is the reason the design uses a worker at all. A token in the page
would let any visitor read, overwrite or delete every response.

## The eight-character tag

Participants do not create accounts. On entering Round 1 they generate a tag such as
`RMBUHUYB` from a 32-character alphabet (no `I`, `O`, `0` or `1`, to survive being read
aloud or copied by hand). The address space is 32⁸ ≈ 1.1 × 10¹².

The tag is a **bearer credential**:

- whoever knows it can retrieve that participant's answers;
- it is the only link between rounds;
- it contains no personal information and cannot be reversed to a person.

Consequences worth stating in your ethics application:

- A participant who loses the tag cannot be re-linked to their data, and you cannot
  delete their record on request unless they still have it.
- Because the tag is the only identifier, the data is pseudonymous rather than strictly
  anonymous, in the same way a study ID is.
- Anything typed into a free-text box is stored as written. Participants are told not to
  include identifying details, but you should scan free-text fields before publishing any
  verbatim quotation.

## Where the data lives

```
Workers KV                       durable buffer, written on every save
  rec:<surveyId>:<tag>           the current record
  live:<tag>                     per-participant index used by the homepage
  dirty:<surveyId>:<tag>         queued for the next git commit
  rl:<ip>:<minute>               rate-limit counter (expires after 2 minutes)

Private git repository           the permanent record
  data/<surveyId>/<tag>.json               current record (overwritten as answers change)
  data/<surveyId>/submitted/<tag>.json     immutable copy written at submission
```

A record looks like this:

```json
{
  "surveyId": "delphi-round-1",
  "tag": "RMBUHUYB",
  "final": true,
  "pageId": "done",
  "firstSeenAt": "2026-11-14T11:40:12.004Z",
  "updatedAt": "2026-11-14T11:51:09.000Z",
  "submittedAt": "2026-11-14T11:51:09.000Z",
  "answers": { "q_gender": "female", "q_factors": ["vocal", "melody"], "s01": "a" },
  "presentation": {
    "scenarios": { "order": ["s07", "s04", "…"], "swapped": { "s07": true, "s04": false } },
    "__seed": "RMBUHUYB"
  },
  "baseline": { "surveyId": "delphi-round-1", "updatedAt": "…", "missing": false },
  "meta": { "lang": "en", "tz": "Asia/Shanghai" },
  "schemaVersion": 1
}
```

`meta` deliberately contains no IP address, no user agent and no referrer. Time zone is
recorded because it is analytically useful (it hints at panel geography) — remove it in
`assets/js/survey/runner.js` if your ethics approval does not cover it.

`presentation` records the randomised order and left/right placement each participant
saw, so an analyst can reconstruct the exact question a stored answer refers to.

## What the browser stores

Only for that participant, on that device:

| Key | Contents |
|---|---|
| `maelstrom.draft.<surveyId>` | the full draft, refreshed every ~400 ms and on page hide |
| `maelstrom.profile` | the tag and which rounds this browser has submitted |
| `maelstrom.language` | the chosen language |

The participant can clear it like any site data. The server copy is what makes the tag
useful across devices.

## Retention and withdrawal

Recommended practice — adjust to what your ethics approval says:

1. Keep the private data repository for as long as the study runs.
2. Publish only anonymised aggregates in `reports/`.
3. To withdraw a participant: delete `data/<surveyId>/<tag>.json` and
   `data/<surveyId>/submitted/<tag>.json` and commit. History still contains the old
   blobs, so if you need a true erasure, rewrite the history or keep the data repository
   short-lived and rely on exported snapshots.
4. Before publishing a summary report, check free-text fields for names, institutions,
   locations and other identifying details.

## Exporting for analysis

```bash
git clone https://github.com/honeray/maelstrom-study-data.git
node tools/export-csv.mjs ../maelstrom-study-data --out dist
```

Produces, in `dist/`:

- `<surveyId>.csv` — one row per tag, one column per answer key;
- `<surveyId>-submitted.csv` — only final submissions;
- `participants.csv` — every tag with its completion status per round, which is what you
  need to invite the panel to the next round.

Multi-select answers are joined with `; ` inside a single cell. Extent answers appear as
`<question>__extent`.

## Threat model, briefly

| Risk | Mitigation |
|---|---|
| Someone edits responses by using the site as a participant | They can only create records under tags they invent; existing tags are not enumerable at scale and rate limiting applies |
| Someone reads all responses | Needs the tag of each participant, or access to the private repository |
| Someone deletes responses through the site | Impossible: the API only upserts its own survey+tag key |
| A leaked token in the page | No token exists in the page |
| Abuse / spam | Survey allow-list, 8-character tag format, 96 KB payload cap, 400-answer cap, 90 requests/minute/IP |
| GitHub outage | KV holds the latest record; the cron retries every two minutes |
| A participant's device dies mid-survey | 10-second autosave to the server plus local draft |

## Ethics checklist

- [ ] Consent text on page 1 matches your ethics approval
- [ ] Contact details in `data/site.json` are current
- [ ] The data repository is private
- [ ] Summary reports contain only anonymised aggregates
- [ ] Free-text fields checked before publishing quotations
- [ ] Participants told that the tag is the only way to link rounds and cannot be recovered
- [ ] Retention period agreed and recorded
