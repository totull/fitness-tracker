const { chromium } = require('playwright-core');
const path = require('path');

const TARGET = process.argv[2] || '';
const TRACKER = /^https?:\/\//i.test(TARGET)
  ? TARGET
  : 'file:///' + path.resolve(TARGET).replace(/\\/g, '/');
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true
  });
  const page = await browser.newPage({
    viewport: { width: 450, height: 980 },
    hasTouch: true,
    isMobile: true
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(TRACKER, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Ignore CDN failures (offline sandbox), keep real JS errors.
  const realErrors = errors.filter((e) => !/supabase|net::ERR|Failed to load resource/i.test(e));
  check('no JS errors on load', realErrors.length === 0, realErrors.join(' | '));

  // The Garmin card lives in the Daily Log view; the app opens on Dashboard.
  await page.locator('.tab-button[data-view="log"]').click();
  await page.waitForTimeout(400);

  const cardCount = await page.locator('.garmin-card').count();
  check('Garmin card renders', cardCount === 1, `found ${cardCount}`);

  const cardVisible = await page.locator('.garmin-card').first().isVisible();
  check('Garmin card visible in Daily Log', cardVisible);

  const syncBtn = page.locator('[data-action="sync-garmin"]');
  check('Sync Garmin button present', (await syncBtn.count()) === 1);

  // Failure path: no cloud config must surface a specific in-card reason.
  await syncBtn.first().click();
  await page.waitForTimeout(600);
  const statusText = (await page.locator('.garmin-status').first().textContent().catch(() => '')) || '';
  check('sync shows in-card status (not silent)', statusText.trim().length > 0, JSON.stringify(statusText));
  check('status names the actual cause', /Supabase URL|anon key|Cloud sync/i.test(statusText), statusText.trim());

  const reason = await page.evaluate(async () => {
    const r = await window.pullGarminRemotePayload({ silent: true });
    return r && r.reason;
  }).catch((e) => 'EVAL_FAIL: ' + e.message);
  check('pull returns machine-readable reason', reason === 'no-config', String(reason));

  // Read path must not filter on a locally cached user id; RLS scopes the row.
  // Stub the Supabase client to exercise the branches without a live project.
  const branches = await page.evaluate(async () => {
    const out = {};
    const makeClient = (rows) => ({
      from: () => ({
        select: () => ({
          order: () => ({
            limit: async () => ({ data: rows, error: null })
          })
        })
      })
    });
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    window.hasRemoteConfig = () => true;
    window.__trackerTest.remoteRuntime.user = { id: 'web-user-uuid', email: 'me@example.com' };

    // Row written by a DIFFERENT user id must still be returned (RLS scopes it).
    window.ensureSupabaseClient = async () => makeClient([{
      user_id: 'companion-user-uuid',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: { '2026-08-16': { steps: 8000 } } } }
    }]);
    out.mismatchedId = (await window.pullGarminRemotePayload({ silent: true })).reason;

    // No row at all.
    window.ensureSupabaseClient = async () => makeClient([]);
    out.noRow = (await window.pullGarminRemotePayload({ silent: true })).reason;
    out.noRowMsg = window.__trackerTest.garminRuntime.status;

    // Row present but carrying no tracker entries.
    window.ensureSupabaseClient = async () => makeClient([{
      user_id: 'web-user-uuid',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: {} } }
    }]);
    out.emptyPayload = (await window.pullGarminRemotePayload({ silent: true })).reason;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    window.__trackerTest.remoteRuntime.user = null;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('row is read via RLS, not a cached user id', branches.mismatchedId === 'ok',
    `reason=${branches.mismatchedId}`);
  check('missing row reports account mismatch', branches.noRow === 'no-data', String(branches.noRow));
  check('missing-row message is actionable', /different account|same project/i.test(branches.noRowMsg || ''),
    String(branches.noRowMsg).slice(0, 90));
  check('empty payload distinguished from missing row', branches.emptyPayload === 'empty-payload',
    String(branches.emptyPayload));

  const w = page.locator('#weightInput');
  check('weight input present', (await w.count()) === 1);
  const inputmode = await w.getAttribute('inputmode');
  check('weight input uses decimal keyboard', inputmode === 'decimal', String(inputmode));

  // Focus must survive a full re-render (the keyboard-dismissal bug).
  await w.focus();
  const focusedBefore = await page.evaluate(() => document.activeElement && document.activeElement.id);
  await page.evaluate(() => window.render());
  await page.waitForTimeout(150);
  const focusedAfter = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('focus retained across render()', focusedBefore === 'weightInput' && focusedAfter === 'weightInput',
    `before=${focusedBefore} after=${focusedAfter}`);

  await page.evaluate(() => {
    const el = document.getElementById('weightInput');
    el.value = '84.8';
    el.focus();
    el.setSelectionRange(2, 2);
  });
  await page.evaluate(() => window.render());
  await page.waitForTimeout(150);
  const caret = await page.evaluate(() => {
    const el = document.getElementById('weightInput');
    return document.activeElement === el ? el.selectionStart : -1;
  });
  check('caret position preserved across render()', caret === 2, `caret=${caret}`);

  await browser.close();

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -> ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();

