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

  // Auto-pull: must stay silent when not signed in, pull when ready, then throttle.
  const auto = await page.evaluate(async () => {
    const out = {};
    const makeClient = (rows) => ({
      from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) })
    });
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;

    // Signed out -> must not fire and must not post a warning.
    window.hasRemoteConfig = () => true;
    window.__trackerTest.remoteRuntime.user = null;
    window.__trackerTest.garminRuntime.status = '';
    out.signedOut = (await window.autoPullGarmin()).skipped;
    out.signedOutStatus = window.__trackerTest.garminRuntime.status;

    // Ready -> pulls. Reset the throttle first: the manual sync exercised
    // earlier in this run legitimately marked the data fresh.
    window.__trackerTest.resetGarminThrottle();
    window.__trackerTest.remoteRuntime.user = { id: 'u1', email: 'me@example.com' };
    window.ensureSupabaseClient = async () => makeClient([{
      user_id: 'u1',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: { '2026-08-16': { steps: 8000 } } } }
    }]);
    out.firstPull = (await window.autoPullGarmin()).reason;

    // Immediately again -> throttled, no second network call.
    out.secondPull = (await window.autoPullGarmin()).skipped;

    // force bypasses the throttle.
    out.forced = (await window.autoPullGarmin({ force: true })).reason;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    window.__trackerTest.remoteRuntime.user = null;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('auto-pull silent when signed out', auto.signedOut === 'not-ready', String(auto.signedOut));
  check('auto-pull posts no warning when signed out', !auto.signedOutStatus,
    String(auto.signedOutStatus).slice(0, 60));
  check('auto-pull fetches when ready', auto.firstPull === 'ok', String(auto.firstPull));
  check('auto-pull throttles repeat calls', auto.secondPull === 'throttled', String(auto.secondPull));
  check('auto-pull force bypasses throttle', auto.forced === 'ok', String(auto.forced));

  const steps = await page.evaluate(() => {
    const e = window.__trackerTest.getState().entries['2026-08-16'];
    return e && e.steps;
  });
  check('auto-pull applied data to the entry', String(steps) === '8000', `steps=${steps}`);

  // A hand-edited field must lock out imports, and must be recoverable.
  const override = await page.evaluate(async () => {
    const out = {};
    const rows = (v) => [{
      user_id: 'u1',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: { '2026-08-16': { steps: String(v) } } } }
    }];
    const makeClient = (v) => ({
      from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: rows(v), error: null }) }) }) })
    });
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    window.hasRemoteConfig = () => true;
    window.__trackerTest.remoteRuntime.user = { id: 'u1', email: 'me@example.com' };

    const st = window.__trackerTest.getState();
    st.selectedDate = '2026-08-16';
    const entry = st.entries['2026-08-16'];

    // Simulate a manual edit of steps.
    entry.steps = '9000';
    window.markGarminManualField(entry, 'steps');
    out.locked = entry.garmin.manualFields.includes('steps');

    // A normal sync must NOT overwrite the manual value.
    window.ensureSupabaseClient = async () => makeClient(11000);
    window.__trackerTest.resetGarminThrottle();
    await window.autoPullGarmin();
    out.afterNormalPull = st.entries['2026-08-16'].steps;

    // "Use Garmin values" must clear the lock and take the Garmin number.
    await window.resetGarminOverrides('2026-08-16');
    out.afterReset = st.entries['2026-08-16'].steps;
    out.lockCleared = !st.entries['2026-08-16'].garmin.manualFields.includes('steps');

    // A later sync with a higher count must now refresh normally.
    window.ensureSupabaseClient = async () => makeClient(12500);
    window.__trackerTest.resetGarminThrottle();
    await window.autoPullGarmin();
    out.afterRefresh = st.entries['2026-08-16'].steps;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    window.__trackerTest.remoteRuntime.user = null;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('manual edit locks the field', override.locked === true, String(override.locked));
  check('sync does not overwrite a manual value', override.afterNormalPull === '9000',
    `steps=${override.afterNormalPull}`);
  check('reset restores the Garmin value', override.afterReset === '11000',
    `steps=${override.afterReset}`);
  check('reset clears the lock', override.lockCleared === true, String(override.lockCleared));
  check('imported field refreshes on later sync', override.afterRefresh === '12500',
    `steps=${override.afterRefresh}`);

  // Tracker-state auto-pull is separate from Garmin. This is the phone ->
  // laptop path for meals, workouts and check-ins.
  const statePull = await page.evaluate(async () => {
    const out = {};
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const runtime = window.__trackerTest.remoteRuntime;
    const st = window.__trackerTest.getState();
    const dateKey = '2026-08-16';
    const remoteEntry = JSON.parse(JSON.stringify(st.entries[dateKey]));
    remoteEntry.meals.breakfast.details = 'Remote phone breakfast';
    const payload = {
      version: st.version,
      startDate: st.startDate,
      profile: JSON.parse(JSON.stringify(st.profile)),
      entries: { [dateKey]: remoteEntry }
    };
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { payload, updated_at: '2026-08-17T11:05:00Z' },
              error: null
            })
          })
        })
      })
    };

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => client;
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.dirty = false;
    window.__trackerTest.resetStateThrottle();

    const first = await window.autoPullRemoteState();
    out.firstHasData = first.hasData;
    out.breakfast = window.__trackerTest.getState().entries[dateKey].meals.breakfast.details;
    out.pullAt = runtime.lastStatePullAt;
    out.second = (await window.autoPullRemoteState()).skipped;

    // An unsent laptop edit must not be silently replaced by auto-pull.
    window.__trackerTest.getState().entries[dateKey].meals.breakfast.details = 'Unsynced laptop edit';
    runtime.dirty = true;
    window.__trackerTest.resetStateThrottle();
    out.dirty = (await window.autoPullRemoteState()).skipped;
    out.afterDirty = window.__trackerTest.getState().entries[dateKey].meals.breakfast.details;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('tracker auto-pull downloads phone state', statePull.firstHasData === true,
    String(statePull.firstHasData));
  check('tracker auto-pull applies phone meals', statePull.breakfast === 'Remote phone breakfast',
    String(statePull.breakfast));
  check('tracker pull has its own timestamp', statePull.pullAt === '2026-08-17T11:05:00Z',
    String(statePull.pullAt));
  check('tracker auto-pull throttles repeats', statePull.second === 'throttled',
    String(statePull.second));
  check('tracker auto-pull protects unsent local edits', statePull.dirty === 'local-changes',
    String(statePull.dirty));
  check('protected local edit remains intact', statePull.afterDirty === 'Unsynced laptop edit',
    String(statePull.afterDirty));

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
