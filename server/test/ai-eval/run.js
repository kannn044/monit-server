#!/usr/bin/env node
// Eval harness for the AI chat.
//
// The reason this exists: without it, "did that prompt change help?" is
// answered by how the last three replies felt, which is not an answer. Every
// question here has a ground truth that comes from SQL, so the model is graded
// against the database rather than against an impression.
//
//   MONIT_URL=http://localhost:8080 MONIT_EMAIL=admin@example.com \
//   MONIT_PASSWORD='…' node server/test/ai-eval/run.js
//
// Add --json to get machine-readable output for a CI step, and run it once
// before a prompt change and once after. A pass rate that went down is the
// whole point of the exercise.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../src/db/pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.MONIT_URL || 'http://localhost:8080').replace(/\/+$/, '');
const EMAIL = process.env.MONIT_EMAIL || 'admin@example.com';
const PASSWORD = process.env.MONIT_PASSWORD;
const asJson = process.argv.includes('--json');

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} — set MONIT_EMAIL and MONIT_PASSWORD`);
  const j = await res.json();
  return j.access_token || j.accessToken || j.token;
}

/** Ask one question and drain the SSE stream into a plain answer + the tools used. */
async function ask(token, question) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let answer = '';
  const tools = [];
  let intent = null;
  let error = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        const e = JSON.parse(d);
        if (e.t === 'delta') answer += e.c;
        if (e.t === 'status' && e.s === 'tool') tools.push(e.name);
        if (e.t === 'meta') intent = e.intent;
        if (e.t === 'error') error = e.m;
      } catch { /* ignore a malformed frame */ }
    }
  }
  return { answer, tools, intent, error, ms: Date.now() - started };
}

/**
 * Grading.
 *
 * Substring matching on a number is crude, and deliberately so: anything
 * cleverer becomes a second thing to debug when a case fails. A number that
 * appears nowhere in the answer is wrong no matter how the sentence is phrased.
 */
function grade(qc, truth, answer) {
  const a = String(answer);
  if (qc.expect_any) {
    const hit = qc.expect_any.some((x) => a.toLowerCase().includes(String(x).toLowerCase()));
    return { pass: hit, expected: qc.expect_any.join(' | ') };
  }
  if (truth === null || truth === undefined) return { pass: null, expected: '(no truth)' };
  const t = String(truth).trim();
  // Numbers are matched on a word boundary so "12" does not pass on "120".
  const pass = /^\d+(\.\d+)?$/.test(t)
    ? new RegExp(`(^|[^\\d.])${t.replace('.', '\\.')}([^\\d.]|$)`).test(a)
    : a.toLowerCase().includes(t.toLowerCase());
  return { pass, expected: t };
}

async function main() {
  if (!PASSWORD) throw new Error('set MONIT_PASSWORD (and MONIT_EMAIL if not admin@example.com)');
  const questions = JSON.parse(await readFile(path.join(HERE, 'questions.json'), 'utf8'));
  const token = await login();

  const results = [];
  for (const qc of questions) {
    let truth = null;
    if (qc.expect_sql) {
      try {
        const { rows } = await pool.query(qc.expect_sql);
        truth = rows[0] ? Object.values(rows[0])[0] : null;
      } catch (e) {
        results.push({ id: qc.id, pass: null, note: `truth query failed: ${e.message}` });
        continue;
      }
      if (qc.skip_if_zero && (truth === null || Number(truth) === 0)) {
        results.push({ id: qc.id, pass: null, note: 'skipped — no data for this feature in this database' });
        continue;
      }
    }
    let r;
    try {
      r = await ask(token, qc.ask);
    } catch (e) {
      results.push({ id: qc.id, pass: false, note: e.message });
      continue;
    }
    const g = grade(qc, truth, r.answer);
    results.push({
      id: qc.id, pass: g.pass, expected: g.expected, intent: r.intent,
      tools: r.tools, ms: r.ms, chars: r.answer.length,
      error: r.error,
      answer: r.answer.slice(0, 400),
    });
  }

  const graded = results.filter((r) => r.pass !== null);
  const passed = graded.filter((r) => r.pass).length;
  const summary = {
    passed, graded: graded.length,
    rate: graded.length ? Math.round((100 * passed) / graded.length) : 0,
    median_ms: median(results.map((r) => r.ms).filter(Boolean)),
    tool_calls: results.reduce((a, r) => a + (r.tools?.length || 0), 0),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.pass === null ? '–' : r.pass ? '✓' : '✗';
      console.log(`${mark} ${r.id.padEnd(22)} ${String(r.ms || '').padStart(6)}ms  `
        + `${(r.tools || []).join(',') || '(no tools)'}`);
      if (r.note) console.log(`    ${r.note}`);
      if (r.pass === false) {
        console.log(`    expected: ${r.expected}`);
        console.log(`    got:      ${String(r.answer || r.error || '').replace(/\n/g, ' ').slice(0, 200)}`);
      }
    }
    console.log(`\n${summary.passed}/${summary.graded} passed (${summary.rate}%) · `
      + `median ${summary.median_ms}ms · ${summary.tool_calls} tool calls`);
  }
  await pool.end();
  process.exit(summary.graded && summary.rate < 60 ? 1 : 0);
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
