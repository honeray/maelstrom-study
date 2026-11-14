# Translations

The site is trilingual. Two kinds of text exist, and they live in different places.

| Kind | Where | Who edits it |
|---|---|---|
| Interface (buttons, errors, labels) | `i18n/en.json`, `i18n/zh.json`, `i18n/fr.json` | anyone |
| Survey content (questions, options, scenarios) | inline in each `data/surveys/*.json` | whoever writes the round |

Both use the same shape: an object keyed by language code.

```json
{ "en": "Getting Your Tag", "zh": "获取您的标签", "fr": "Obtenir votre étiquette" }
```

## Status of the current text

> **The Chinese and French text in this repository is a machine-assisted draft and has not
> been reviewed by a fluent speaker.** It was written to make the three-language
> requirement work end to end, not to be used in the field unchanged.

Before opening a round to real participants:

1. Have a native speaker review `i18n/zh.json`, `i18n/fr.json` and the `zh` / `fr` values
   in `data/surveys/*.json`.
2. Pay particular attention to the contextual scenarios in Round 1: several are about
   sexual misconduct, racism, child discipline and war. Wording that is merely awkward in
   English can be offensive or legally loaded in another language. A literal translation
   is not the goal.
3. Set `"translationStatus": "reviewed"` in `data/site.json` once the review is complete.

## How a participant switches language

The selector in the header switches immediately, keeps every answer, and re-renders the
current page. The choice is remembered in the browser and can be forced with `?lang=zh`,
`?lang=fr` or `?lang=en`.

Missing translations never break the page: `loc()` falls back to English, then to
whichever language is present.

## Editing interface strings

1. Edit `i18n/en.json` first, then mirror the key in `zh.json` and `fr.json`.
2. Keys must match exactly across all three files — `npm run validate` fails otherwise,
   and also fails when a key used in the code is missing.
3. Rebuild nothing. Refresh the page.

Placeholders use braces: `"step": "Page {current} of {total}"`. Keep the placeholder names
identical in every language.

## Editing survey content

Find the block in `data/surveys/*.json` and replace the `zh` or `fr` string. Never change
an `id`: ids are the keys in stored responses.

Rules that the validator enforces:

- every `title`, `prompt`, `label`, `text`, option label and `a`/`b` scenario needs all
  three languages;
- no extra language keys;
- no duplicate ids.

## Adding a fourth language

1. Add it to `languages` in `assets/js/config.js`:

   ```js
   { code: "es", label: "Español", short: "ES" }
   ```

2. Copy `i18n/en.json` to `i18n/es.json` and translate the values.
3. Add an `"es"` value to every localised object in `data/surveys/*.json`.
4. Run `npm run validate`.

The language menu, storage and fallbacks all read from `config.js`, so no other code
changes are needed.

## Terminology (keep these consistent)

| English | 中文 | Français | Note |
|---|---|---|---|
| tag | 标签 | étiquette | The participant's eight-character identifier |
| round | 轮 / 轮次 | tour | A survey round |
| preliminary round | 预调查 | tour préliminaire | Used in survey titles |
| free response | 自由作答 | réponse libre | |
| anonymous | 匿名 | anonymisé | |
| summary report | 汇总报告 | rapport de synthèse | |
| neutral | 中立 | neutre | The middle option in every scale |
| agree / neutral / disagree | 同意 / 中立 / 不同意 | d'accord / neutre / pas d'accord | |
| slightly / somewhat / strongly | 略微 / 较为 / 非常 | légèrement / assez / fortement | Follow-up intensity |
| musicality | 音乐性 | musicalité | |
| memorability | 记忆度 | mémorabilité | |
| coherence | 连贯性 | cohérence | |
