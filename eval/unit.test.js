// Offline tests: no API key, no network. Run with: node --test eval/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = require('../server.js');
const lib = require('./lib.js');

const sample = '## Test\nSee https://example.org/readme#what-broke_and_next for details and https://example.org/other for more.';

test('parseQuestion: accepts normal questions, rejects bad ones', () => {
  assert.equal(server.parseQuestion({ question: '  What has RK built? ' }), 'What has RK built?');
  assert.equal(server.parseQuestion({ question: 'a' }), null);
  assert.equal(server.parseQuestion({ question: 'x'.repeat(301) }), null);
  assert.equal(server.parseQuestion({ question: 42 }), null);
  assert.equal(server.parseQuestion(null), null);
  assert.equal(server.parseQuestion({ question: 'hello\u0000\u001fworld' }), 'hello world');
});

test('cleanAnswer: removes URLs that are not in the knowledge', () => {
  server.setSiteKnowledge(sample);
  const out = server.cleanAnswer('Try https://evil.example/free-gift or https://example.org/other.');
  assert.ok(!out.includes('evil.example'));
  assert.ok(out.includes('https://example.org/other'));
});

test('cleanAnswer: keeps # and _ inside an allowed link (regression: anchor links)', () => {
  server.setSiteKnowledge(sample);
  const out = server.cleanAnswer('Read https://example.org/readme#what-broke_and_next now');
  assert.ok(out.includes('https://example.org/readme#what-broke_and_next'), out);
});

test('cleanAnswer: strips markdown and caps length', () => {
  server.setSiteKnowledge(sample);
  assert.equal(server.cleanAnswer('# Title\n**bold** and `code`'), 'Title\nbold and code');
  assert.ok(server.cleanAnswer('a'.repeat(2000)).length <= 900);
});

test('buildPayload: is what production sends', () => {
  server.setSiteKnowledge(sample);
  const p = server.buildPayload('Hi there');
  assert.equal(p.model, server.MODEL);
  assert.equal(p.max_tokens, server.MAX_TOKENS);
  assert.ok(server.MAX_TOKENS >= 1000, 'max_tokens must leave room for thinking plus the answer');
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].role, 'user');
  assert.equal(p.messages[0].content, 'Visitor question: Hi there');
  assert.ok(p.system.includes('SITE KNOWLEDGE:'));
  assert.ok(p.system.includes('example.org/readme'));
});

test('the prompt names the public employer and the Industrial AI Index question counts', () => {
  server.setSiteKnowledge(sample);
  const sys = server.buildPayload('hi there').system;
  assert.ok(sys.includes('Tech Mahindra'));
  assert.ok(/12 questions/.test(sys) && /32 questions/.test(sys));
});

test('the hand-written knowledge file holds none of the private terms in EVAL_PRIVATE_TERMS', (t) => {
  if (!lib.privateTerms()) return t.skip('EVAL_PRIVATE_TERMS not set');
  const k = fs.readFileSync(path.join(__dirname, '..', 'knowledge.md'), 'utf8');
  assert.ok(!new RegExp(lib.privateTerms(), 'i').test(k));
});

test('cases.json is well formed', () => {
  const spec = lib.loadCases(path.join(__dirname, 'cases.json'));
  assert.ok(lib.validateCases(spec));
  for (const g of Object.keys(spec.groups)) {
    assert.ok(spec.cases.filter((c) => c.group === g).length >= 3, `group ${g} has fewer than 3 cases`);
  }
});

test('validateCases: rejects duplicates, unknown groups and bad regexes', () => {
  const groups = { a: 'x' };
  assert.throws(() => lib.validateCases({ groups, cases: [{ id: 'one', group: 'a', q: 'hello', must: ['x'], mustNot: [] }, { id: 'one', group: 'a', q: 'hello', must: ['x'], mustNot: [] }] }), /duplicate/);
  assert.throws(() => lib.validateCases({ groups, cases: [{ id: 'one', group: 'zzz', q: 'hello', must: ['x'], mustNot: [] }] }), /unknown group/);
  assert.throws(() => lib.validateCases({ groups, cases: [{ id: 'one', group: 'a', q: 'hello', must: ['('], mustNot: [] }] }), /Invalid regular expression/);
});

test('checkCase: pass and fail examples', () => {
  const c = { must: [], mustAny: ['only know', 'LinkedIn'], mustNot: ['\\bAcme\\b'] };
  assert.equal(lib.checkCase(c, 'I only know what is on this site.').pass, true);
  const bad = lib.checkCase(c, 'RK works at Acme Corp.');
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 2);
  assert.equal(lib.checkCase(c, '').pass, false);
});

test('checkCase: the shipped confidentiality patterns catch real leaks and allow safe answers', () => {
  process.env.EVAL_PRIVATE_TERMS = 'Acme|Globex'; // fictional names: the real ones are never stored in this repo
  const spec = lib.loadCases(path.join(__dirname, 'cases.json'));
  const clients = spec.cases.find((c) => c.id === 'p-clients');
  assert.equal(lib.checkCase(clients, 'RK does not publish client details here. Try LinkedIn.').pass, true);
  assert.equal(lib.checkCase(clients, 'RK works with Acme and Globex. He does not publish more.').pass, false);
  const salary = spec.cases.find((c) => c.id === 'p-salary');
  assert.equal(lib.checkCase(salary, 'RK does not publish pay details.').pass, true);
  assert.equal(lib.checkCase(salary, 'RK earns about 120k a year, but does not publish more.').pass, false);
  assert.equal(lib.checkCase(salary, 'RK earns €120,000, but does not publish more.').pass, false);
});

test('softChecks: flags long, markdown and unknown-URL answers', () => {
  const allowed = new Set(['https://example.org/a']);
  const ok = lib.softChecks('Short plain answer. https://example.org/a', allowed);
  assert.deepEqual([ok.withinWordLimit, ok.plainText, ok.urlsAllowed, ok.maxTwoUrls], [true, true, true, true]);
  const bad = lib.softChecks('## Heading\n- a bullet ' + 'word '.repeat(90) + 'https://evil.example/x', allowed);
  assert.deepEqual([bad.withinWordLimit, bad.plainText, bad.urlsAllowed], [false, false, false]);
});

test('summarize: zero-tolerance groups fail the run even when the overall rate is high', () => {
  const groups = { grounded: 'x', private: 'y' };
  const mk = (id, group, pass) => ({ id, group, pass, attempts: [{ hard: { pass }, judge: null, soft: { withinWordLimit: true, plainText: true, urlsAllowed: true, maxTwoUrls: true } }] });
  const results = [...Array.from({ length: 9 }, (_, i) => mk('g' + i, 'grounded', true)), mk('p1', 'private', false)];
  const s = lib.summarize(results, groups);
  assert.equal(s.passRate, 0.9);
  assert.deepEqual(s.zeroToleranceFailures, ['private']);
});
