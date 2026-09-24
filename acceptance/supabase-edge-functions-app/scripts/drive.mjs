// Drive the real, unmodified app in real Chromium through real user
// interactions (EXPECTATIONS.md S1-S6), and record for every step which
// collector files (frontend interaction AppMaps) appeared and which HTTP
// requests actually went over the wire, with their headers.
//
// usage: node drive.mjs sequence|parallel
// env: APP_URL, CHROME (optional executable), OUT (json report path),
//      COLLECTOR_DIR (<app>/tmp/appmap/interactions), RUN_ID (email suffix),
//      TOOLS (dir whose node_modules has playwright-core), PARALLEL (N users)
import { createRequire } from 'node:module';
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.env.TOOLS, 'package.json'));
const { chromium } = require('playwright-core');

const MODE = process.argv[2] ?? 'sequence';
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3300';
const COLLECTOR_DIR = process.env.COLLECTOR_DIR;
const RUN_ID = process.env.RUN_ID ?? String(Date.now());
const FN = 'select-from-table-with-auth-rls';
const PASSWORD = 'acceptance-pass-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listMaps = () =>
  COLLECTOR_DIR && existsSync(COLLECTOR_DIR)
    ? readdirSync(COLLECTOR_DIR).filter((f) => f.endsWith('.appmap.json')).sort()
    : [];

// Wait until no new collector file for `quietMs` (window idles out after
// >= 250 ms, then POSTs), capped at `maxMs`.
async function settle(quietMs = 1500, maxMs = 15000) {
  const start = Date.now();
  let last = listMaps().length;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(100);
    const n = listMaps().length;
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) break;
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  headless: true,
  args: [
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ],
});

async function newPage(report, tag) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Local only. Not via page.route(): with request interception on,
  // Playwright answers CORS preflights itself, which would hide exactly the
  // preflight behaviour this harness has to observe. External hosts are made
  // unresolvable at the browser's DNS layer instead (launch args below).
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.port !== '54321') return; // only the Supabase gateway (app traffic)
    report.wire.push({ tag, t: Date.now(), method: r.method(), url: r.url(), headers: r.headers() });
  });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) report.blockedExternal.push(r.url());
    if (u.port !== '54321') return;
    report.failed.push({ tag, method: r.method(), url: r.url(), error: r.failure()?.errorText });
  });
  page.on('console', (m) => report.console.push({ tag, type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', (e) => report.pageErrors.push({ tag, error: String(e).slice(0, 500) }));
  page.on('dialog', async (d) => {
    report.dialogs.push({ tag, message: d.message().slice(0, 300) });
    await d.dismiss();
  });
  return { context, page };
}

async function responseText(page) {
  return (await page.locator('pre').first().textContent())?.trim() ?? '';
}

async function step(report, id, desc, fn) {
  if (report.appDidNotRender) {
    report.steps.push({ id, desc, error: 'skipped: the app did not render (S1 failed)', newMaps: [], wire: [], response: null });
    return;
  }
  const before = new Set(listMaps());
  const wireBefore = report.wire.length;
  const t0 = Date.now();
  let error;
  try {
    await fn();
  } catch (e) {
    error = String(e).slice(0, 500);
  }
  await settle();
  report.steps.push({
    id,
    desc,
    ms: Date.now() - t0,
    error,
    newMaps: listMaps().filter((f) => !before.has(f)),
    wire: report.wire.slice(wireBefore).map((w) => ({ method: w.method, url: w.url, traceparent: w.headers.traceparent ?? null })),
    response: step.page ? await responseText(step.page).catch(() => null) : null,
  });
}

async function signUp(page, email) {
  // @supabase/auth-ui-react 0.2.x: sign-in view first, link to sign-up view.
  await page.getByText("Don't have an account? Sign up").click();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByText(`Logged in as ${email}`).waitFor({ timeout: 15000 });
}

async function invoke(page) {
  await page.getByRole('button', { name: 'Invoke Function' }).click();
  await page.waitForFunction(() => !document.querySelector('pre')?.textContent?.includes('"loading"'), null, {
    timeout: 15000,
  });
}

async function sequence() {
  const report = { mode: 'sequence', steps: [], wire: [], failed: [], console: [], pageErrors: [], dialogs: [], blockedExternal: [] };
  const { page } = await newPage(report, 'seq');
  step.page = page;
  const email = `seq-${RUN_ID}@example.com`;
  await step(report, 'S1', 'load the app', async () => {
    await page.goto(APP_URL);
    await page.getByRole('button', { name: 'Invoke Function' }).waitFor({ timeout: 30000 });
  });
  if (report.steps[0].error) report.appDidNotRender = true;
  await step(report, 'S2', 'invoke with the default dropdown entry (not served) -> 404', () => invoke(page));
  await step(report, 'S3', `select ${FN}, invoke signed out -> 200, no rows`, async () => {
    await page.locator('select').selectOption(FN);
    await invoke(page);
  });
  await step(report, 'S4', 'sign up (auto-confirmed) -> signed in', () => signUp(page, email));
  await step(report, 'S5', 'invoke signed in -> 200, own row only (RLS)', () => invoke(page));
  await step(report, 'S6', 'sign out', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByText("Don't have an account? Sign up").waitFor({ timeout: 15000 });
  });
  report.email = email;
  return report;
}

async function parallel() {
  const n = Number(process.env.PARALLEL ?? 3);
  const report = { mode: 'parallel', users: [], steps: [], wire: [], failed: [], console: [], pageErrors: [], dialogs: [], blockedExternal: [] };
  const pages = [];
  for (let i = 0; i < n; i++) {
    const tag = `par${i}`;
    const { page } = await newPage(report, tag);
    const email = `par${i}-${RUN_ID}@example.com`;
    await page.goto(APP_URL);
    try {
      await page.getByRole('button', { name: 'Invoke Function' }).waitFor({ timeout: 30000 });
    } catch (e) {
      report.appDidNotRender = true;
      report.steps.push({ id: 'I', desc: 'app did not render', error: String(e).slice(0, 300), newMaps: [], wire: [] });
      return report;
    }
    await page.locator('select').selectOption(FN);
    await signUp(page, email);
    pages.push({ tag, page, email });
  }
  await settle();
  const before = new Set(listMaps());
  const wireBefore = report.wire.length;
  // All N users click "Invoke Function" at the same moment.
  await Promise.all(pages.map(({ page }) => page.getByRole('button', { name: 'Invoke Function' }).click()));
  await Promise.all(
    pages.map(({ page }) =>
      page.waitForFunction(() => !document.querySelector('pre')?.textContent?.includes('"loading"'), null, { timeout: 20000 }),
    ),
  );
  await settle();
  for (const p of pages) report.users.push({ tag: p.tag, email: p.email, response: await responseText(p.page) });
  report.steps.push({
    id: 'I',
    desc: `${n} users invoke concurrently`,
    newMaps: listMaps().filter((f) => !before.has(f)),
    wire: report.wire.slice(wireBefore).map((w) => ({ tag: w.tag, method: w.method, url: w.url, traceparent: w.headers.traceparent ?? null })),
  });
  return report;
}

let report;
try {
  report = MODE === 'parallel' ? await parallel() : await sequence();
} finally {
  await browser.close();
}
writeFileSync(process.env.OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.steps.map((s) => ({ id: s.id, error: s.error, maps: s.newMaps.length, wire: s.wire.length }))));
