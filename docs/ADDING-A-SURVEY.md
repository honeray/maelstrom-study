# Adding or editing a survey round

A survey is **one self-contained JSON file** in `data/surveys/`, registered in
`data/surveys.json`. There is no build step and no code to change unless you want a new
kind of question.

---

## 1. The minimum

`data/surveys/delphi-round-3.json`:

```json
{
  "id": "delphi-round-3",
  "code": "R3",
  "estimateMinutes": 20,
  "flow": { "createsTag": false, "requiresTag": true, "baselineSurvey": "delphi-round-2" },
  "title": { "en": "Music Evaluation Survey (Preliminary Round 3)", "zh": "…", "fr": "…" },
  "shortTitle": { "en": "Preliminary Round 3", "zh": "…", "fr": "…" },
  "summary": { "en": "…", "zh": "…", "fr": "…" },
  "pages": [
    {
      "id": "intro",
      "title": { "en": "Welcome", "zh": "欢迎", "fr": "Bienvenue" },
      "blocks": [
        { "type": "prose", "text": { "en": "Welcome!", "zh": "欢迎！", "fr": "Bienvenue !" } }
      ]
    }
  ]
}
```

and in `data/surveys.json`:

```json
{ "id": "delphi-round-3", "file": "data/surveys/delphi-round-3.json",
  "code": "R3", "order": 3, "status": "scheduled" }
```

Remember to add the id to `SURVEYS` in `worker/wrangler.toml` as well, or the worker
will reject its saves.

Run `npm run validate` — it will tell you if anything is missing.

## 2. Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Must match the id in `data/surveys.json` |
| `code` | yes | Short badge shown on the homepage and header (`R1`) |
| `title` | yes | Full title, shown in the browser tab and banner |
| `shortTitle` | no | Used in the survey header |
| `summary` | no | Reserved for listing pages |
| `estimateMinutes` | no | Rendered as "about N minutes" on the homepage |
| `flow.createsTag` | no | `true` if this round generates the tag (Round 1 only) |
| `flow.requiresTag` | no | `true` if a tag is needed before saving |
| `flow.baselineSurvey` | no | Id of the round whose answers are pre-loaded (Round 2+) |
| `pages` | yes | Ordered list of pages |

## 3. Pages

| Field | Meaning |
|---|---|
| `id` | Unique within the survey; also stored as the participant's position |
| `title` | Heading, also used as the progress label |
| `eyebrow` | Small label above the title (`REVISION`, `STEP 1 OF 2`) |
| `blocks` | Ordered content |
| `submit` | Exactly one page should have `"submit": true`; its button locks the response |
| `submitLabel` / `nextLabel` | Button text overrides |
| `randomize` | `"blocks"` shuffles all `scenarioPair` blocks on the page |
| `include` | Import pages from another survey instead of defining blocks |
| `kind` | `"completion"` marks the terminal thank-you page |

A survey must contain exactly one `submit` page and at least one `kind: "completion"`
page; the validator enforces this.

### Reusing an earlier round's questions

```json
{
  "include": { "from": "delphi-round-1", "pages": ["demographics", "factors", "scenarios"] },
  "with": { "eyebrow": { "en": "Revision", "zh": "修订", "fr": "Révision" } }
}
```

`with` is merged over each imported page, so you can retitle a page without duplicating
its questions. Question ids stay identical, which is what makes Round 2's pre-fill and
the before/after comparison work.

> Because includes are resolved at runtime against the *current* Round 1 file, do not
> edit a closed round's questions: that would silently change what a later round asks.
> If you must revise questions, copy them into the new file instead.

## 4. Blocks

Every block may carry `hint` (small text under the prompt) and `required` (defaults to
**false** — set `"required": true` explicitly on anything that gates the Next button).

### `prose`

```json
{ "type": "prose", "text": { "en": "Welcome to the **first round**." } }
```

Supports `**bold**`, `*italic*`, `` `code` ``, `[text](https://…)`, blank-line paragraphs,
and `- ` bullet lists. Everything else is escaped, so HTML in a survey file is inert.
Add `"variant": "muted"` for smaller, quieter text.

### `callout`

```json
{ "type": "callout", "tone": "info", "title": { "en": "Heads up" },
  "text": { "en": "Your answers are saved automatically." } }
```

`tone`: `info` (default), `warn`, `danger`.

### `contact`

Renders the study contact block from `data/site.json`. Optional `heading`.

### `consent`

```json
{ "type": "consent", "id": "consent_start", "required": true,
  "label": { "en": "I have read the above and am ready to begin." } }
```

Stored as `true` / absent.

### `tagGenerate`

```json
{ "type": "tagGenerate", "id": "tag" }
```

Generates an eight-character tag, copies it to the clipboard and stores it with the
response. Use once, on the round that creates the tag.

### `tagLookup`

```json
{ "type": "tagLookup", "id": "tag_lookup", "required": true, "allowSkip": true }
```

Verifies a tag against `flow.baselineSurvey`, then loads those answers. `allowSkip: true`
shows a "I lost my tag" escape hatch that starts a blank copy under a new tag.

### `tagDisplay`

Shows the participant's tag (used on the thank-you page).

### `resumePrompt`

An inline "Already have a tag?" box, for rounds that generate the tag.

### Text questions

```json
{ "type": "shortText", "id": "q_language", "required": true,
  "prompt": { "en": "What is your mother tongue?" } }
```

`longText` is identical but renders a textarea; add `"tall": true` for a taller box.
Both accept `placeholder`, `maxLength`, `hint`. Stored as a string.

### `singleChoice`

```json
{
  "type": "singleChoice", "id": "q_gender", "required": true,
  "prompt": { "en": "What is your gender?" },
  "options": [
    { "id": "male", "label": { "en": "Male" } },
    { "id": "other", "allowText": true, "label": { "en": "Other (please specify)" } }
  ]
}
```

- `layout: "inline"` puts short options in a responsive grid.
- `allowText: true` reveals a text field and stores it as `<id>__other`.
- Stored as the selected option id.

### `multiChoice`

Same shape plus `"minSelections": 1`. Stored as an array of ids in authored order.

### `branchScale`

The "unipolar question branch" from the study outlines: a first choice, then a
follow-up only for certain answers.

```json
{
  "type": "branchScale", "id": "q_factors_sufficient", "required": true,
  "prompt": { "en": "Do you agree or disagree with the following statement?" },
  "statement": { "en": "\"…the statement…\"" },
  "options": [
    { "id": "agree", "label": { "en": "Agree" } },
    { "id": "neutral", "label": { "en": "Neutral" } },
    { "id": "disagree", "label": { "en": "Disagree" } }
  ],
  "followUp": {
    "when": ["agree", "disagree"],
    "prompt": { "en": "To what extent?" },
    "options": [
      { "id": "slightly", "label": { "en": "Slightly" } },
      { "id": "somewhat", "label": { "en": "Somewhat" } },
      { "id": "strongly", "label": { "en": "Strongly" } }
    ]
  }
}
```

Stored as `<id>` and `<id>__extent`. Choosing `neutral` clears the extent automatically.

### `scenarioPair`

```json
{
  "type": "scenarioPair", "id": "s01", "required": true,
  "a": { "en": "An emotional song with English lyrics is sung to an English-speaking audience." },
  "b": { "en": "…sung to a non-English-speaking audience." },
  "followUp": { "prompt": { "en": "To what extent?" }, "options": [ … ] }
}
```

Renders two labelled cards then A / Neutral / B. Stored as `a`, `neutral` or `b` plus
`<id>__extent` and an optional `<id>__comment`.

The pairs' order and left/right placement are shuffled **deterministically from the
participant's tag**, so a participant always sees the same order, and Round 2 reproduces
it exactly. The order and swap map are saved in `presentation` so analysis can recover
what was shown.

## 5. How answers are stored

Flat keys, sorted, empty values dropped:

```json
{
  "q_gender": "female",
  "q_country": "other",
  "q_country__other": "Argentina",
  "q_factors": ["vocal", "melody"],
  "q_aural_only": "disagree",
  "q_aural_only__extent": "strongly",
  "s03": "a",
  "s03__extent": "somewhat",
  "s03__comment": "…"
}
```

Suffix conventions:

| Suffix | Meaning |
|---|---|
| `__other` | "Other (please specify)" text |
| `__extent` | branch follow-up answer |
| `__comment` | free-text comment attached to a scenario pair |

Anything without a suffix is the answer itself.

## 6. Checklist before you open a round

- [ ] `npm run validate` passes
- [ ] Every new string exists in **all three** languages
- [ ] A fluent speaker has reviewed the Chinese and French text
- [ ] The new survey id is in `SURVEYS` in `worker/wrangler.toml`, and the worker is
      redeployed
- [ ] `status` in `data/surveys.json` is `open` (and the previous round is `closed`)
- [ ] You walked the round once on a phone, completed it, and found the record in the
      data repository
