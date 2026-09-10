# Icon credits and licences

This project embeds third-party brand marks in `src/components/brand-marks.tsx`
to identify the AI providers and databases it monitors. This file records where
each came from and under what terms, so the repository can be redistributed
without ambiguity.

No icon is loaded from a third-party CDN at runtime — every mark is inlined as
SVG path data. That means no external request, no hotlinking (which most icon
services forbid), and no runtime dependency.

## Marks under CC0 1.0 (public domain)

Source: [Simple Icons](https://github.com/simple-icons/simple-icons) — the SVG
files are released under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/), which
requires no attribution. They are credited here anyway, as a courtesy.

| Mark | Slug |
| --- | --- |
| OpenAI | `openai` |
| Claude | `claude` |
| Anthropic | `anthropic` |
| Google Gemini | `googlegemini` |
| Qwen | `qwen` |
| ElevenLabs | `elevenlabs` |
| Deepgram | `deepgram` |
| PostgreSQL | `postgresql` |
| MySQL | `mysql` |
| SQLite | `sqlite` |

## Marks requiring attribution

| Mark | Source | Licence |
| --- | --- | --- |
| Groq | [File:Groq logo.svg](https://commons.wikimedia.org/wiki/File:Groq_logo.svg), Wikimedia Commons | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

Groq publishes no separate square icon mark, so this is the wordmark and is
rendered in a wide slot. **CC BY-SA 4.0 requires attribution**, which this entry
provides. If you modify the Groq SVG path data, the modified file must remain
CC BY-SA 4.0. If you would rather not carry that obligation, delete
`GroqMark` from `brand-marks.tsx` and remove its entry from the ambient
background — nothing else depends on it.

## Not included

- **pgAdmin** — its logo is a multi-path colour illustration of the PostgreSQL
  elephant (Slonik), which does not reduce to a single monochrome path and is
  already represented by the PostgreSQL mark. It is not in Simple Icons.

## Trademarks

Company names, logos and brand marks are the property of their respective
owners, including the following registered trademarks:

- **PostgreSQL**, **Postgres** and the elephant logo (Slonik) are registered
  trademarks of the PostgreSQL Community Association.
- **MySQL** is a registered trademark of Oracle Corporation.

They are used here solely to identify the third-party services this dashboard
integrates with — nominative use. Their presence does **not** imply that any of
these companies sponsor, endorse, or are affiliated with this project.

If you fork this project and rebrand it, review each mark's trademark policy
before shipping. Identifying a service you integrate with is generally
permitted; implying endorsement is not.
