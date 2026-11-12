# rk-assistant

The "Ask this site" assistant behind radhakrishnakamaraju.com. One endpoint, `POST /api/ask`, answers short visitor questions using only `knowledge.md`.

- Question: up to 300 characters. Nothing is stored or logged.
- Answers: up to about 80 words; any URL not listed in `knowledge.md` is stripped.
- Limits: 10 questions per visitor per hour, 30 per day in total (both configurable in `.env`).
- Update what it knows by editing `knowledge.md` and pushing; the server redeploys itself.

Deploy: `cp .env.example .env`, add the API key, `docker compose up -d --build`.
