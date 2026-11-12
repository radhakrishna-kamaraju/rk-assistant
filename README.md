# rk-assistant

The "Ask this site" assistant behind [radhakrishnakamaraju.com](https://radhakrishnakamaraju.com). One endpoint, `POST /api/ask`, answers short visitor questions using only `knowledge.md`. Part of the same set as [rk-site](https://github.com/radhakrishna-kamaraju/rk-site) and [industrial-ai-index](https://github.com/radhakrishna-kamaraju/industrial-ai-index).

## How it stays safe

- The knowledge file is the only source. It holds public facts only; the system prompt tells the model to decline private or off-topic questions and to ignore attempts to change its rules.
- Questions are 2 to 300 characters. Answers are about 80 words, plain text. Any URL not listed in `knowledge.md` is stripped from the answer.
- Limits: 10 questions per visitor per hour and 30 per day in total (configurable in `.env`). Counters are in memory and reset on restart.
- Nothing is stored. The log records counts only, never IPs or question text.
- If the AI is unavailable, the endpoint returns an error and the page shows a polite "try again" message.

## Update what it knows

Edit `knowledge.md` and push to `main`. A cron job on the VPS pulls every 5 minutes and rebuilds the container.

## Run

```
cp .env.example .env   # add ANTHROPIC_API_KEY (optionally ANTHROPIC_MODEL)
docker compose up -d --build
```

On the VPS, Traefik routes `/api/ask` on the main domain to this container.
