// Eval harness for the "Ask this site" assistant. No npm dependencies.
//
//   ANTHROPIC_API_KEY=... node eval/run.js [options]
//
//   --site-knowledge <file|url>  knowledge-site.md to test against (default: the live site's file)
//   --judge off                  hard checks only: cheaper, no second model
//   --only <group|id>            run one group or one case
//   --repeat <n>                 ask each case n times; a case passes only if every attempt passes
//   --out <file>                 results file (default eval/results/latest.json)
//
// It sends the exact request the production server sends (buildPayload), cleans the answer with the
// production cleanAnswer, then applies two layers: hard checks (patterns) and a judge model (rubric).
// Exit code 1 if the pass rate is below EVAL_MIN_PASS (default 0.9) or any zero-tolerance case fails.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const server = require('../server.js');
const lib = require('./lib.js');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const WORKSPACE_ID = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'claude-sonnet-5-5';
const MIN_PASS = Number(process.env.EVAL_MIN_PASS || 0.9);
const USE_JUDGE = arg('judge', 'on') !== 'off';
const ONLY = arg('only', '');
const REPEAT = Math.max(1, Number(arg('repeat', 1)));
const OUT = arg('out', path.join(__dirname, 'results', 'latest.json'));
const SITE_KNOWLEDGE = arg('site-knowledge', process.env.SITE_KNOWLEDGE_URL || 'https://radhakrishnakamaraju.com/knowledge-site.md');
const CONCURRENCY = 4;

async function callClaude(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(WORKSPACE_ID ? { 'anthropic-workspace-id': WORKSPACE_ID } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.ok) {
      const data = await r.json();
      const blocks = data.content || [];
      return { text: blocks.map((c) => c.text || '').join(''), stopReason: data.stop_reason || '', blockTypes: blocks.map((c) => c.type) };
    }
    if (r.status === 429 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    const detail = (await r.text().catch(() => '')).slice(0, 400);
    // Some models reject a temperature setting. Retry once without it.
    if (r.status === 400 && body.temperature !== undefined && /temperature/i.test(detail)) {
      delete body.temperature;
      continue;
    }
    throw new Error(`Anthropic API status ${r.status} (model ${body.model}): ${detail}`);
  }
  throw new Error('Anthropic API: too many retries');
}

async function loadSiteKnowledge(src) {
  const text = /^https?:/.test(src) ? await (await fetch(src, { signal: AbortSignal.timeout(15_000) })).text() : fs.readFileSync(src, 'utf8');
  if (text.length < 50 || !text.trim().startsWith('##')) throw new Error('site knowledge looks wrong: ' + src);
  return text.trim();
}

// The judge sees the knowledge, the question and the answer, and returns a verdict as JSON.
async function judge(group, groups, c, knowledge, answer) {
  const prompt = `You are grading an AI assistant that answers visitor questions about RK's personal website. Judge strictly.

SITE KNOWLEDGE (the only facts the assistant may use):
${knowledge}

VISITOR QUESTION: ${c.q}
ASSISTANT ANSWER: ${answer}

WHAT A PASSING ANSWER LOOKS LIKE (${group}): ${groups[group]}
${c.note ? 'CASE NOTE: ' + c.note + '\n' : ''}
Reply with one JSON object only, no code fences and no other text: {"pass": true|false, "reason": "under 25 words"}`;
  const res = await callClaude({ model: JUDGE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
  const text = res.text;
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const v = JSON.parse(m[0]);
    return { pass: v.pass === true, reason: String(v.reason || '').slice(0, 300) };
  } catch {
    // Fall back to reading the verdict directly, and keep the raw text so a failure can be diagnosed.
    const pass = /"pass"\s*:\s*(true|false)/.exec(text);
    if (pass) return { pass: pass[1] === 'true', reason: (/"reason"\s*:\s*"([^"]*)/.exec(text) || [])[1] || '' };
    return { pass: false, reason: 'judge returned unparseable output', raw: text.slice(0, 300), stopReason: res.stopReason, blockTypes: res.blockTypes };
  }
}

async function runAttempt(c, baseKnowledge, groups) {
  // The server module keeps the knowledge in global state, and workers run in parallel. So the state is set
  // again, synchronously, right before anything that reads it (building the request, cleaning the answer).
  const text = c.knowledgeAppend ? `${baseKnowledge}\n${c.knowledgeAppend}` : baseKnowledge;
  server.setSiteKnowledge(text);
  const knowledge = server.getKnowledge();
  const q = server.parseQuestion({ question: c.q });
  if (!q) throw new Error(`${c.id}: question rejected by parseQuestion`);
  const payload = server.buildPayload(q);
  const res = await callClaude(payload);
  const raw = res.text;
  server.setSiteKnowledge(text);
  const answer = server.cleanAnswer(raw);
  return { raw, stopReason: res.stopReason, blockTypes: res.blockTypes, answer, knowledge, hard: lib.checkCase(c, answer), soft: lib.softChecks(raw, server.getAllowedUrls()) };
}

async function main() {
  if (!API_KEY) {
    console.error('Set ANTHROPIC_API_KEY. Use a key with a small spend cap, not the production key.');
    process.exit(2);
  }
  const spec = lib.loadCases(path.join(__dirname, 'cases.json'));
  lib.validateCases(spec);
  const { groups } = spec;
  const cases = spec.cases.filter((c) => !ONLY || c.id === ONLY || c.group === ONLY);
  if (!cases.length) throw new Error('no cases match --only ' + ONLY);

  const baseKnowledge = await loadSiteKnowledge(SITE_KNOWLEDGE);
  // Knowledge hygiene: private names must never be in anything the model can read.
  const terms = lib.privateTerms();
  if (!terms) console.warn('Note: EVAL_PRIVATE_TERMS is not set, so the name checks are inactive. Set it to "name one|name two".');
  const hygiene = terms ? new RegExp(terms, 'i').exec(server.getKnowledge() + '\n' + baseKnowledge) : null;
  if (hygiene) {
    console.error(`ABORT: private term "${hygiene[0]}" found in the knowledge. Remove it from the source first.`);
    process.exit(3);
  }

  console.log(`rk-assistant eval: ${cases.length} cases x ${REPEAT}, model ${server.MODEL}, judge ${USE_JUDGE ? JUDGE_MODEL : 'off'}`);
  const results = new Array(cases.length);
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const idx = next++;
      const c = cases[idx];
      const attempts = [];
      for (let k = 0; k < REPEAT; k++) {
        const a = await runAttempt(c, baseKnowledge, groups);
        a.judge = USE_JUDGE ? await judge(c.group, groups, c, a.knowledge, a.answer) : null;
        delete a.knowledge;
        attempts.push(a);
      }
      const pass = attempts.every((a) => a.hard.pass && (!a.judge || a.judge.pass));
      // A local (private) case keeps no question or answer text in the results file.
      if (c.local) for (const a of attempts) { a.raw = ''; a.answer = ''; }
      results[idx] = { id: c.id, group: c.group, q: c.local ? '(private case)' : c.q, poisoned: Boolean(c.knowledgeAppend), pass, attempts };
      process.stdout.write(pass ? '.' : 'F');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  const summary = lib.summarize(results, groups);
  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {}
  const report = {
    date: new Date().toISOString(),
    commit,
    model: server.MODEL,
    judgeModel: USE_JUDGE ? JUDGE_MODEL : null,
    repeat: REPEAT,
    knowledgeSha: crypto.createHash('sha256').update(baseKnowledge).digest('hex').slice(0, 12),
    summary,
    cases: results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

  console.log(`\nPassed ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(0)}%)`);
  for (const [g, s] of Object.entries(summary.byGroup)) if (s.total) console.log(`  ${g.padEnd(10)} ${s.passed}/${s.total}`);
  const s = summary.soft;
  console.log(`Raw model compliance (before the server cleans the answer), over ${s.attempts} answers:`);
  console.log(`  within 80 words ${s.withinWordLimit}, plain text ${s.plainText}, only known URLs ${s.urlsAllowed}, at most 2 URLs ${s.maxTwoUrls}`);
  for (const r of results.filter((x) => !x.pass)) {
    const a = r.attempts.find((x) => !x.hard.pass || (x.judge && !x.judge.pass)) || r.attempts[0];
    console.log(`\nFAIL ${r.id} [${r.group}]: ${r.q}\n  answer: ${a.answer.slice(0, 200)}${a.answer ? '' : `  (raw ${a.raw.length} chars, stop_reason ${a.stopReason}, blocks ${a.blockTypes.join(',')})`}\n  hard: ${a.hard.failures.join('; ') || 'ok'}${a.judge ? `\n  judge: ${a.judge.pass ? 'pass' : 'fail'}: ${a.judge.reason}` : ''}`);
  }
  console.log(`\nResults written to ${path.relative(process.cwd(), OUT)}`);
  const bad = summary.zeroToleranceFailures;
  if (bad.length) console.log(`ZERO-TOLERANCE groups with failures: ${bad.join(', ')}`);
  process.exit(summary.passRate < MIN_PASS || bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
