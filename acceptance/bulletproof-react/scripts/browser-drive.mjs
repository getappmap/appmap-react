// Drive the real app in real Chromium through real user interactions and
// record, for each one, which collector files appeared and which HTTP
// requests actually went over the wire (with their headers).
//
// env: APP_DIR (app root, for resolving playwright), APP_URL, CHROME (path),
//      OUT (json report path), COLLECTOR_DIR (tmp/appmap/interactions)
import { createRequire } from 'node:module';
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.env.APP_DIR, 'package.json'));
const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const COLLECTOR_DIR = process.env.COLLECTOR_DIR;
const listMaps = () =>
  existsSync(COLLECTOR_DIR) ? readdirSync(COLLECTOR_DIR).filter((f) => f.endsWith('.appmap.json')).sort() : [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until no new collector file has appeared for `quietMs` (the recorder
// idle-closes after >=250 ms and POSTs), capped at `maxMs`.
async function settle(quietMs = 1500, maxMs = 12000) {
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

const report = { steps: [], wire: [], console: [], pageErrors: [] };
// Keep Chromium's own background traffic (update checks, etc.) off the
// network: everything under test is on localhost.
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  headless: true,
  args: [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--disable-features=OptimizationHints,MediaRouter,Translate',
  ],
});
const page = await browser.newPage();
// Local only: the app's index.html pulls a web font from rsms.me; abort
// every non-localhost request and log it.
report.blockedExternal = [];
await page.route(
  (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
  (route) => {
    report.blockedExternal.push(route.request().url());
    return route.abort();
  },
);
page.on('console', (m) => report.console.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 400)));
let currentStep = 'load';
page.on('request', async (req) => {
  const url = req.url();
  if (!url.includes(':8080/')) return;
  report.wire.push({
    step: currentStep,
    method: req.method(),
    url,
    traceparent: (await req.allHeaders())['traceparent'] ?? null,
  });
});

async function step(name, action) {
  await settle(800, 4000); // let any previous window close first
  const before = listMaps();
  currentStep = name;
  const t0 = Date.now();
  await action();
  await settle();
  const after = listMaps();
  report.steps.push({
    name,
    newMaps: after.filter((f) => !before.includes(f)),
    ms: Date.now() - t0,
  });
}

const email = `acc-${Date.now()}@example.com`;
await page.goto(`${APP_URL}/auth/register`);
await page.getByLabel('First Name').waitFor({ timeout: 30000 });
await settle(1500, 6000);
report.preexistingMaps = listMaps();

await page.getByLabel('First Name').fill('Ada');
await page.getByLabel('Last Name').fill('Lovelace');
await page.getByLabel('Email Address').fill(email);
await page.getByLabel('Password').fill('secret-pw-1');
await page.getByLabel('Team Name').fill('Acceptance Team');

await step('B1 register', async () => {
  await page.getByRole('button', { name: 'Register' }).click();
  await page.waitForURL('**/app', { timeout: 15000 });
  await page.getByText('Welcome').waitFor({ timeout: 15000 });
});

await step('B2 list page', async () => {
  await page.getByRole('link', { name: 'Discussions' }).first().click();
  await page.getByText(/No Entries Found/i).waitFor({ timeout: 15000 });
});

await step('B3 open create drawer', async () => {
  await page.getByRole('button', { name: 'Create Discussion' }).click();
  await page.getByRole('dialog', { name: 'Create Discussion' }).waitFor({ timeout: 10000 });
});

await step('B4 create item', async () => {
  const drawer = page.getByRole('dialog', { name: 'Create Discussion' });
  // typing is not a trigger (click/submit only), so it opens no window
  await drawer.getByLabel('Title').fill('Acceptance discussion');
  await drawer.getByLabel('Body').fill('Created by the acceptance run');
  await drawer.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('cell', { name: 'Acceptance discussion' }).waitFor({ timeout: 15000 });
});

// B5: two interactions fired ~20 ms apart: open the Users page (GET
// /users) and, before that settles, navigate to the Dashboard (no fetch).
await step('B5 two clicks 20ms apart', async () => {
  await page.getByRole('link', { name: 'Users' }).first().click({ noWaitAfter: true });
  await sleep(20);
  await page.getByRole('link', { name: 'Dashboard' }).first().click({ noWaitAfter: true });
  await page.getByText('Welcome').waitFor({ timeout: 15000 });
});

report.allMaps = listMaps();
await browser.close();
writeFileSync(process.env.OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ steps: report.steps, wire: report.wire.length }, null, 2));
