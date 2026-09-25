#!/usr/bin/env node
// Runs one acceptance suite and holds its verdicts to the suite's ledger,
// acceptance/<suite>/KNOWN_FAILURES.json.
//
//   node acceptance/known-failures.mjs <suite-dir> -- <command> [args...]
//
// The suite's own exit code says "some check failed". That alone would keep
// CI red forever over limitations we have already written down, or tempt
// someone to mark the job continue-on-error and stop reading it. Instead:
//
// - every check the ledger names must appear, with exactly the verdict line
//   the ledger records (a check that disappears, or changes its verdict text,
//   fails the job);
// - a check the ledger lists as failing that now passes fails the job too,
//   so the ledger is corrected (and the limitation retired) on purpose;
// - any failing check not in the ledger fails the job.
//
// The ledger never makes a check pass: RESULTS.md and the uploaded evidence
// still report it as FAIL, with the reason the ledger gives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sep = process.argv.indexOf('--');
const suiteDir = process.argv[2];
const cmd = process.argv.slice(sep + 1);
if (sep !== 3 || !suiteDir || cmd.length === 0) {
  console.error('usage: known-failures.mjs <suite-dir> -- <command> [args...]');
  process.exit(2);
}
const ledgerPath = path.join(suiteDir, 'KNOWN_FAILURES.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

// "A: PASS", "[acc] L: FAIL", "I: FAIL (vitest isolation: PASS, ...)",
// and the setup-failure form "A FAIL (setup): ...".
const VERDICT = /^(?:\[\w+\]\s*)?([A-Z][A-Za-z0-9_-]*(?: [a-z][A-Za-z0-9_-]*)?):? ((?:PASS|FAIL|NOT RUN|MEASURED)\b.*)$/;
const seen = new Map();
let buf = '';
let all = '';
const take = (chunk) => {
  buf += chunk;
  all += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trimEnd();
    buf = buf.slice(i + 1);
    const m = VERDICT.exec(line);
    if (m && !/^\s/.test(line)) seen.set(m[1], m[2].trim());
  }
};

const child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { process.stdout.write(d); take(String(d)); });
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('close', (code) => {
  take('\n');
  const problems = [];
  for (const [key, want] of Object.entries(ledger.checks)) {
    const got = seen.get(key);
    if (got === undefined) problems.push(`${key}: missing from this run (ledger expects "${want.verdict}")`);
    else if (got !== want.verdict) {
      const fixed = /^(PASS|MEASURED)/.test(got) && !/^(PASS|MEASURED)/.test(want.verdict);
      problems.push(fixed
        ? `${key}: now "${got}" but the ledger lists it as a known failure ("${want.verdict}") — update ${ledgerPath} and RESULTS.md`
        : `${key}: got "${got}", ledger expects "${want.verdict}"`);
    }
    // A failing check must still fail for the recorded reason, not a new one.
    for (const e of want.evidence ?? []) {
      if (!all.includes(e)) problems.push(`${key}: expected evidence line not in output: ${e}`);
    }
  }
  for (const [key, got] of seen) {
    if (!(key in ledger.checks) && !/^(PASS|MEASURED)/.test(got)) {
      problems.push(`${key}: "${got}" — a failure the ledger does not know about`);
    }
  }
  console.log(`\n== ledger (${ledgerPath}), suite exit ${code}`);
  for (const [key, want] of Object.entries(ledger.checks)) {
    if (!/^(PASS|MEASURED)/.test(want.verdict)) console.log(`known failure ${key}: ${want.reason}`);
  }
  if (problems.length) {
    for (const p of problems) console.log(`LEDGER MISMATCH ${p}`);
    process.exit(1);
  }
  if (code !== 0 && ![...seen.values()].some((v) => !/^(PASS|MEASURED)/.test(v))) {
    console.log(`LEDGER MISMATCH suite exited ${code} with no failing check reported`);
    process.exit(1);
  }
  console.log('ledger: every verdict matches');
});
