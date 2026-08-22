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
  check('selected-day Garmin sync button present',
    (await page.locator('[data-action="garmin-sync-selected"]').count()) === 1);
  check('explicit tracker upload action present',
    (await page.locator('[data-action="remote-push"]').count()) === 1);
  check('explicit tracker download action present',
    (await page.locator('[data-action="remote-pull"]').count()) === 1);
  const headerSync = page.locator('#syncIndicator');
  check('header sync indicator is visible', await headerSync.isVisible());
  await headerSync.click();
  check('sync sheet opens from header', await page.locator('#syncDialog').evaluate((el) => el.open));
  check('sync sheet contains one Sync now action',
    (await page.locator('#syncDialog [data-action="sync-now"]').count()) === 1);
  await page.locator('#syncDialog [data-action="close-sync"]').click();

  await page.evaluate(() => {
    window.__trackerTest.remoteRuntime.dirty = false;
    window.__trackerTest.getState().syncMeta = { dirty: false };
  });
  await page.locator('.tab-button[data-view="progress"]').click();
  await page.waitForTimeout(850);
  const navigationDirty = await page.evaluate(() => ({
    runtime: window.__trackerTest.remoteRuntime.dirty,
    persisted: window.__trackerTest.getState().syncMeta?.dirty
  }));
  check('view navigation never marks tracker data dirty',
    !navigationDirty.runtime && !navigationDirty.persisted, JSON.stringify(navigationDirty));
  await page.locator('.tab-button[data-view="log"]').click();
  await page.waitForTimeout(100);

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
    const recentDate = window.__trackerTest.dateKeyMinusDays(window.__trackerTest.todayKey(), 1);
    out.recentDate = recentDate;
    window.__trackerTest.resetGarminThrottle();
    window.__trackerTest.remoteRuntime.user = { id: 'u1', email: 'me@example.com' };
    window.ensureSupabaseClient = async () => makeClient([{
      user_id: 'u1',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: { [recentDate]: { steps: 8000 } } } }
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

  const steps = await page.evaluate((dateKey) => {
    const e = window.__trackerTest.getState().entries[dateKey];
    return e && e.steps;
  }, auto.recentDate);
  check('auto-pull applied data to the entry', String(steps) === '8000', `steps=${steps}`);

  // A hand-edited field must lock out imports, and must be recoverable.
  const override = await page.evaluate(async () => {
    const out = {};
    const dateKey = window.__trackerTest.dateKeyMinusDays(window.__trackerTest.todayKey(), 1);
    const rows = (v) => [{
      user_id: 'u1',
      updated_at: '2026-08-17T04:00:00Z',
      payload: { trackerPayloadPatch: { entries: { [dateKey]: { steps: String(v) } } } }
    }];
    const makeClient = (v) => ({
      from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: rows(v), error: null }) }) }) })
    });
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    window.hasRemoteConfig = () => true;
    window.__trackerTest.remoteRuntime.user = { id: 'u1', email: 'me@example.com' };

    const st = window.__trackerTest.getState();
    st.selectedDate = dateKey;
    const entry = window.__trackerTest.ensureEntry(dateKey);

    // Simulate a manual edit of steps.
    entry.steps = '9000';
    window.markGarminManualField(entry, 'steps');
    out.locked = entry.garmin.manualFields.includes('steps');

    // A normal sync must NOT overwrite the manual value.
    window.ensureSupabaseClient = async () => makeClient(11000);
    window.__trackerTest.resetGarminThrottle();
    await window.autoPullGarmin();
    out.afterNormalPull = st.entries[dateKey].steps;

    // "Use Garmin values" must clear the lock and take the Garmin number.
    await window.resetGarminOverrides(dateKey);
    out.afterReset = st.entries[dateKey].steps;
    out.lockCleared = !st.entries[dateKey].garmin.manualFields.includes('steps');

    // A later sync with a higher count must now refresh normally.
    window.ensureSupabaseClient = async () => makeClient(12500);
    window.__trackerTest.resetGarminThrottle();
    await window.autoPullGarmin();
    out.afterRefresh = st.entries[dateKey].steps;

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

  // Rolling Garmin window: automatic sync should not keep reprocessing old
  // already-synced days, manual sync gets a wider safety window, and the
  // selected-day force action remains available for historical corrections.
  const garminWindow = await page.evaluate(() => {
    const out = {};
    const t = window.__trackerTest;
    const today = t.todayKey();
    const recent = t.dateKeyMinusDays(today, 1);
    const edge = t.dateKeyMinusDays(today, t.garminWindows.auto - 1);
    const autoOld = t.dateKeyMinusDays(today, t.garminWindows.auto);
    const manualOk = t.dateKeyMinusDays(today, t.garminWindows.manual - 1);
    const manualOld = t.dateKeyMinusDays(today, t.garminWindows.manual);

    const autoResult = window.applyGarminCompanionPayload({
      source: { provider: 'Health Connect' },
      trackerPayloadPatch: {
        entries: {
          [recent]: { steps: '7100' },
          [edge]: { steps: '7200' },
          [autoOld]: { steps: '7300' }
        }
      }
    }, {
      queueRemote: false,
      windowDays: t.garminWindows.auto,
      referenceDateKey: today
    });
    out.autoApplied = autoResult.appliedDays;
    out.autoSkipped = autoResult.skippedDays;
    out.recentSteps = t.getState().entries[recent]?.steps;
    out.edgeSteps = t.getState().entries[edge]?.steps;
    out.autoOldSteps = t.getState().entries[autoOld]?.steps;

    const manualResult = window.applyGarminCompanionPayload({
      source: { provider: 'Health Connect' },
      trackerPayloadPatch: {
        entries: {
          [manualOk]: { steps: '7600' },
          [manualOld]: { steps: '7700' }
        }
      }
    }, {
      queueRemote: false,
      windowDays: t.garminWindows.manual,
      referenceDateKey: today
    });
    out.manualApplied = manualResult.appliedDays;
    out.manualSkipped = manualResult.skippedDays;
    out.manualOkSteps = t.getState().entries[manualOk]?.steps;
    out.manualOldSteps = t.getState().entries[manualOld]?.steps;

    const forceResult = window.applyGarminCompanionPayload({
      source: { provider: 'Health Connect' },
      trackerPayloadPatch: { entries: { [manualOld]: { steps: '7900' } } }
    }, {
      queueRemote: false,
      windowDays: 0,
      forceDates: new Set([manualOld]),
      referenceDateKey: today
    });
    out.forceApplied = forceResult.appliedDays;
    out.forceOldSteps = t.getState().entries[manualOld]?.steps;
    t.getState().selectedDate = '2026-08-16';
    t.ensureEntry('2026-08-16');
    return out;
  }).catch((e) => ({ err: e.message }));

  check('automatic Garmin sync applies only the rolling 3-day window',
    garminWindow.autoApplied === 2 && garminWindow.autoSkipped === 1,
    JSON.stringify(garminWindow));
  check('automatic Garmin sync skips old entries',
    garminWindow.recentSteps === '7100' && garminWindow.edgeSteps === '7200' && garminWindow.autoOldSteps !== '7300',
    JSON.stringify(garminWindow));
  check('manual Garmin sync applies the wider 7-day window',
    garminWindow.manualApplied === 1 && garminWindow.manualSkipped === 1 && garminWindow.manualOkSteps === '7600',
    JSON.stringify(garminWindow));
  check('forced selected-day Garmin sync can import an older date',
    garminWindow.forceApplied === 1 && garminWindow.forceOldSteps === '7900',
    JSON.stringify(garminWindow));

  const breakfastInput = page.locator(
    '[data-meal-key="breakfast"][data-meal-field="details"]'
  );
  await breakfastInput.fill('Phone breakfast upload');
  await breakfastInput.press('Tab');
  await page.waitForTimeout(150);
  const savedMealFromUi = await page.evaluate(() => {
    const st = window.__trackerTest.getState();
    return {
      details: st.entries[st.selectedDate]?.meals?.breakfast?.details,
      persistedDirty: st.syncMeta?.dirty,
      runtimeDirty: window.__trackerTest.remoteRuntime.dirty
    };
  });
  check('typing in meal UI persists to browser state',
    savedMealFromUi.details === 'Phone breakfast upload', String(savedMealFromUi.details));
  check('meal edit persists unsent-change marker',
    savedMealFromUi.persistedDirty === true && savedMealFromUi.runtimeDirty === true,
    JSON.stringify(savedMealFromUi));

  // Upload must verify what Supabase stored and display the real operation
  // result instead of hiding it behind the signed-in email.
  const statePush = await page.evaluate(async () => {
    const out = {};
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const runtime = window.__trackerTest.remoteRuntime;
    const st = window.__trackerTest.getState();
    const dateKey = '2026-08-16';
    st.selectedDate = dateKey;

    const makeClient = (mutateStored, existingPayload = null) => ({
      from: () => ({
        select: () => ({
          maybeSingle: async () => ({
            data: existingPayload
              ? { payload: existingPayload, updated_at: '2026-08-17T11:09:00Z' }
              : null,
            error: null
          })
        }),
        upsert: (row) => ({
          select: () => ({
            single: async () => {
              const stored = JSON.parse(JSON.stringify(row));
              if (mutateStored) mutateStored(stored);
              return {
                data: { payload: stored.payload, updated_at: '2026-08-17T11:10:00Z' },
                error: null
              };
            }
          })
        })
      })
    });

    window.hasRemoteConfig = () => true;
    runtime.user = { id: 'u1', email: 'me@example.com' };

    window.ensureSupabaseClient = async () => makeClient();
    const good = await window.pushRemoteState({ silent: true });
    out.good = good.success;
    out.meals = good.summary?.mealCount;
    out.status = runtime.status;
    out.label = window.remoteStatusLabel();
    out.dirtyCleared = !runtime.dirty && !st.syncMeta?.dirty;

    window.ensureSupabaseClient = async () => makeClient((stored) => {
      stored.payload.entries[dateKey].meals.breakfast.details = '';
    });
    const bad = await window.pushRemoteState({ silent: true });
    out.bad = bad.success;
    out.badMessage = bad.message;

    const richerCloud = JSON.parse(JSON.stringify(window.buildRemotePayload()));
    richerCloud.entries[dateKey].meals.lunch.details = 'Cloud-only lunch';
    window.ensureSupabaseClient = async () => makeClient(null, richerCloud);
    const blocked = await window.pushRemoteState({ silent: true });
    out.blockedReason = blocked.reason;
    out.blockedMessage = blocked.message;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('tracker upload verifies stored payload', statePush.good === true, String(statePush.good));
  check('verified upload reports meal count', statePush.meals >= 1, `meals=${statePush.meals}`);
  check('sync status shows operation result, not email', /Uploaded and verified/.test(statePush.label || ''),
    String(statePush.label));
  check('verified upload clears persisted dirty marker', statePush.dirtyCleared === true,
    String(statePush.dirtyCleared));
  check('cloud payload mismatch fails verification', statePush.bad === false, String(statePush.bad));
  check('verification failure is actionable', /Cloud verification failed/.test(statePush.badMessage || ''),
    String(statePush.badMessage));
  check('poorer browser cannot overwrite richer cloud copy',
    statePush.blockedReason === 'cloud-richer', String(statePush.blockedReason));
  check('blocked overwrite explains the count difference',
    /Upload blocked to prevent data loss/.test(statePush.blockedMessage || ''),
    String(statePush.blockedMessage));

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
    Object.values(remoteEntry.meals).forEach((meal) => {
      meal.details = '';
      meal.caloriesOverride = '';
      meal.macroOverride = '';
    });
    remoteEntry.meals.breakfast.details = 'Remote phone breakfast';
    const payload = {
      version: st.version,
      startDate: st.startDate,
      profile: JSON.parse(JSON.stringify(st.profile)),
      entries: { [dateKey]: remoteEntry }
    };
    let cloudPayload = payload;
    const client = {
      from: () => ({
        select: () => ({
          maybeSingle: async () => ({
            data: { payload: cloudPayload, updated_at: '2026-08-17T11:05:00Z' },
            error: null
          })
        })
      })
    };

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => client;
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.dirty = false;
    runtime.entrySyncAvailable = false;
    window.__trackerTest.resetStateThrottle();

    const first = await window.autoPullRemoteState();
    out.firstHasData = first.hasData;
    out.breakfast = window.__trackerTest.getState().entries[dateKey].meals.breakfast.details;
    out.pullAt = runtime.lastStatePullAt;
    out.second = (await window.autoPullRemoteState()).skipped;

    // A cloud download must not erase a richer local day.
    window.__trackerTest.getState().entries[dateKey].meals.lunch.details = 'Local-only lunch';
    cloudPayload = JSON.parse(JSON.stringify(payload));
    Object.values(cloudPayload.entries[dateKey].meals).forEach((meal) => {
      meal.details = '';
      meal.caloriesOverride = '';
      meal.macroOverride = '';
    });
    cloudPayload.entries[dateKey].meals.breakfast.details = 'Remote phone breakfast';
    runtime.dirty = false;
    const protectedPull = await window.pullRemoteState({ silent: true });
    out.protectedPull = protectedPull.reason;
    out.protectedMessage = runtime.status;
    out.localLunchAfterPull =
      window.__trackerTest.getState().entries[dateKey].meals.lunch.details;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.dirty = false;
    runtime.entrySyncAvailable = null;
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
  check('poorer cloud copy cannot erase richer browser data',
    /Download blocked to protect this browser/.test(statePull.protectedMessage || ''),
    String(statePull.protectedMessage));
  check('blocked download preserves local meal',
    statePull.localLunchAfterPull === 'Local-only lunch', String(statePull.localLunchAfterPull));

  // Revisioned per-day sync: different dates merge; the same date conflicts.
  const perDay = await page.evaluate(async () => {
    const out = {};
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const runtime = window.__trackerTest.remoteRuntime;
    const st = window.__trackerTest.getState();
    const cloudDate = '2026-08-15';
    const localDate = '2026-08-16';

    const cloudEntry = JSON.parse(JSON.stringify(st.entries[localDate]));
    Object.values(cloudEntry.meals).forEach((meal) => {
      meal.details = '';
      meal.caloriesOverride = '';
      meal.macroOverride = '';
    });
    cloudEntry.meals.breakfast.details = 'Cloud breakfast';

    const localEntry = JSON.parse(JSON.stringify(st.entries[localDate]));
    Object.values(localEntry.meals).forEach((meal) => {
      meal.details = '';
      meal.caloriesOverride = '';
      meal.macroOverride = '';
    });
    localEntry.meals.lunch.details = 'Local lunch';

    const rows = new Map([
      [cloudDate, {
        entry_date: cloudDate,
        payload: cloudEntry,
        revision: 1,
        updated_at: '2026-08-17T10:00:00Z'
      }]
    ]);

    function tableApi(table) {
      if (table === 'fitness_tracker_entries') {
        const copy = (value) => JSON.parse(JSON.stringify(value));
        return {
          select: () => {
            let filterDate = null;
            const api = {
              limit: async (count) => ({
                data: copy(Array.from(rows.values()).slice(0, count)),
                error: null
              }),
              order: async () => ({
                data: copy(Array.from(rows.values()).sort((a, b) =>
                  a.entry_date.localeCompare(b.entry_date)
                )),
                error: null
              }),
              eq: (_column, value) => {
                filterDate = value;
                return api;
              },
              maybeSingle: async () => ({
                data: filterDate && rows.get(filterDate) ? copy(rows.get(filterDate)) : null,
                error: null
              })
            };
            return api;
          },
          upsert: (input) => ({
            select: () => ({
              single: async () => {
                const previous = rows.get(input.entry_date);
                const row = {
                  entry_date: input.entry_date,
                  payload: JSON.parse(JSON.stringify(input.payload)),
                  revision: previous ? previous.revision + 1 : 1,
                  updated_at: '2026-08-17T11:30:00Z'
                };
                rows.set(input.entry_date, row);
                return { data: row, error: null };
              }
            })
          })
        };
      }
      return {
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null })
        })
      };
    }

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => ({ from: tableApi });
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    st.entries = { [localDate]: localEntry };
    st.selectedDate = localDate;
    st.syncMeta = {
      dirty: true,
      entries: {
        [localDate]: {
          dirty: true,
          localUpdatedAt: '2026-08-17T11:00:00Z',
          cloudRevision: 0,
          cloudUpdatedAt: ''
        }
      }
    };

    const first = await window.syncTrackerEntries({ silent: true });
    out.firstSuccess = first.success;
    out.uploaded = first.uploaded;
    out.downloaded = first.downloaded;
    out.cloudBreakfast = st.entries[cloudDate]?.meals?.breakfast?.details;
    out.localLunchInCloud = rows.get(localDate)?.payload?.meals?.lunch?.details;

    // Legacy migration may mark an identical local row dirty. It should be
    // acknowledged without creating a conflict or another revision.
    window.markEntryDirty(localDate);
    const identical = await window.syncTrackerEntries({ silent: true });
    out.identicalSuccess = identical.success;
    out.identicalRevision = rows.get(localDate).revision;

    // If another device only advanced the revision (same payload), a stale
    // dirty flag must auto-clear instead of re-opening a manual conflict loop.
    window.markEntryDirty(localDate);
    const staleRow = rows.get(localDate);
    staleRow.revision = staleRow.revision + 1;
    staleRow.updated_at = '2026-08-17T11:45:00Z';
    const stale = await window.syncTrackerEntries({ silent: true });
    out.staleDirtyReason = stale.success ? 'ok' : stale.reason;
    out.staleDirtyCleared = st.syncMeta.entries[localDate]?.dirty === false;
    out.staleDirtyRevision = st.syncMeta.entries[localDate]?.cloudRevision;

    // Both devices now change the same day from revision 1.
    st.entries[cloudDate].meals.breakfast.details = 'Local changed breakfast';
    window.markEntryDirty(cloudDate);
    const remoteChanged = rows.get(cloudDate);
    remoteChanged.payload.meals.breakfast.details = 'Other device breakfast';
    remoteChanged.revision = 2;
    remoteChanged.updated_at = '2026-08-17T12:00:00Z';

    const second = await window.syncTrackerEntries({ silent: true });
    out.conflictReason = second.reason;
    out.conflictDate = second.conflicts?.[0];
    out.localPreserved = st.entries[cloudDate].meals.breakfast.details;
    out.remotePreserved = rows.get(cloudDate).payload.meals.breakfast.details;
    out.conflictButtons = document.querySelectorAll(
      '#syncConflictArea [data-action="resolve-sync-conflict"]'
    ).length;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('per-day sync succeeds', perDay.firstSuccess === true, String(perDay.firstSuccess));
  check('different cloud date downloads independently', perDay.cloudBreakfast === 'Cloud breakfast',
    String(perDay.cloudBreakfast));
  check('different local date uploads independently', perDay.localLunchInCloud === 'Local lunch',
    String(perDay.localLunchInCloud));
  check('identical legacy copy does not conflict', perDay.identicalSuccess === true,
    String(perDay.identicalSuccess));
  check('identical legacy copy does not create revision', perDay.identicalRevision === 1,
    String(perDay.identicalRevision));
  check('stale dirty flag does not reopen a conflict loop', perDay.staleDirtyReason === 'ok',
    String(perDay.staleDirtyReason));
  check('stale dirty flag is cleared after sync', perDay.staleDirtyCleared === true,
    String(perDay.staleDirtyCleared));
  check('stale dirty day learns the new cloud revision', perDay.staleDirtyRevision === 2,
    String(perDay.staleDirtyRevision));
  check('same-date concurrent edits create conflict', perDay.conflictReason === 'conflict',
    String(perDay.conflictReason));
  check('conflict identifies the changed date', perDay.conflictDate === '2026-08-15',
    String(perDay.conflictDate));
  check('conflict preserves local version', perDay.localPreserved === 'Local changed breakfast',
    String(perDay.localPreserved));
  check('conflict preserves remote version', perDay.remotePreserved === 'Other device breakfast',
    String(perDay.remotePreserved));
  check('sync sheet offers both conflict choices', perDay.conflictButtons === 2,
    String(perDay.conflictButtons));

  const migration = await page.evaluate(async () => {
    const out = {};
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const runtime = window.__trackerTest.remoteRuntime;
    const st = window.__trackerTest.getState();
    const dateKey = '2026-08-14';
    const legacyEntry = JSON.parse(JSON.stringify(st.entries['2026-08-15']));
    legacyEntry.meals.breakfast.details = 'Migrated legacy breakfast';
    const rows = new Map();

    const client = {
      from: (table) => {
        if (table === 'fitness_tracker_state') {
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: {
                  payload: {
                    version: st.version,
                    profile: st.profile,
                    entries: { [dateKey]: legacyEntry }
                  }
                },
                error: null
              })
            })
          };
        }
        return {
          select: () => ({
            limit: async () => ({
              data: Array.from(rows.values()).slice(0, 1),
              error: null
            }),
            order: async () => ({
              data: Array.from(rows.values()),
              error: null
            })
          }),
          upsert: (input) => ({
            select: () => {
              if (Array.isArray(input)) {
                const inserted = input.map((item) => {
                  const row = {
                    entry_date: item.entry_date,
                    payload: JSON.parse(JSON.stringify(item.payload)),
                    revision: 1,
                    updated_at: '2026-08-17T12:30:00Z'
                  };
                  rows.set(item.entry_date, row);
                  return row;
                });
                return Promise.resolve({ data: inserted, error: null });
              }
              return {
                single: async () => ({ data: null, error: new Error('unexpected single upsert') })
              };
            }
          })
        };
      }
    };

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => client;
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    st.entries = {};
    st.syncMeta = { dirty: false, entries: {} };

    const result = await window.syncTrackerEntries({ silent: true });
    out.success = result.success;
    out.migrated = rows.size;
    out.details = st.entries[dateKey]?.meals?.breakfast?.details;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('legacy cloud row migrates automatically', migration.success === true,
    JSON.stringify(migration));
  check('migration creates per-day row', migration.migrated === 1, String(migration.migrated));
  check('migrated day is applied locally', migration.details === 'Migrated legacy breakfast',
    String(migration.details));

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

  // --- Food catalog + unmatched-food reporting -----------------------------
  // The silent-skip bug: an unrecognized food contributed 0 kcal with no
  // indication, so a typo quietly under-counted the whole day.
  const unmatched = await page.evaluate(() =>
    window.__trackerTest.estimateMealNutritionFromText('2 eggs, blorptacos')
  );
  check('unrecognized foods are reported, not skipped silently',
    unmatched.unrecognizedCount === 1 && /blorptacos/.test(unmatched.unrecognizedNames.join(',')),
    JSON.stringify(unmatched.unrecognizedNames));
  check('recognized foods still counted alongside unrecognized',
    unmatched.recognizedCount === 1 && unmatched.calories > 0,
    `count=${unmatched.recognizedCount} kcal=${unmatched.calories}`);

  const allMatched = await page.evaluate(() =>
    window.__trackerTest.estimateMealNutritionFromText('2 eggs, 1 roti')
  );
  check('fully recognized meal reports no unmatched foods',
    allMatched.unrecognizedCount === 0, JSON.stringify(allMatched.unrecognizedNames));

  // The warning must actually reach the user, not just the data layer.
  await page.locator('.tab-button[data-view="log"]').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const box = document.querySelector('textarea[data-meal-field="details"]');
    box.value = 'blorptacos';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const hintText = await page.evaluate(() => document.body.innerText);
  check('unmatched food surfaces a visible warning in the UI',
    /blorptacos/i.test(hintText) && /not counted|0 kcal|No food match/i.test(hintText));

  // Catalog loads lazily and must never shrink the curated list.
  const catalogSize = await page.evaluate(async () => {
    await window.__trackerTest.loadFoodCatalog();
    return window.__trackerTest.foodCatalogSize();
  });
  check('food catalog is at least the curated baseline', catalogSize >= 27, `size=${catalogSize}`);

  // Curated entries must win over generated ones (hand-tuned for this user).
  const paneer = await page.evaluate(() =>
    window.__trackerTest.estimateMealNutritionFromText('100g paneer')
  );
  check('curated paneer value wins over generated catalog',
    paneer.calories === 265, `kcal=${paneer.calories}`);

  // --- Garmin + manual data must merge, not overwrite each other -----------
  // Real-world failure: phone logged weight/meals, laptop pulled Garmin. The
  // import did not mark the day dirty, so the next pull discarded the Garmin
  // fields locally and never uploaded them.
  const merge = await page.evaluate(async () => {
    const out = {};
    const st = window.__trackerTest.getState();
    const runtime = window.__trackerTest.remoteRuntime;
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const today = st.selectedDate;
    const rows = new Map();
    const copy = (v) => JSON.parse(JSON.stringify(v));

    function tableApi(table) {
      if (table === 'fitness_tracker_entries') {
        return {
          select: () => {
            let filterDate = null;
            const api = {
              limit: async (n) => ({ data: copy([...rows.values()].slice(0, n)), error: null }),
              order: async () => ({ data: copy([...rows.values()]), error: null }),
              eq: (_c, v) => { filterDate = v; return api; },
              maybeSingle: async () => ({
                data: filterDate && rows.get(filterDate) ? copy(rows.get(filterDate)) : null,
                error: null
              })
            };
            return api;
          },
          upsert: (input) => ({
            select: () => ({
              single: async () => {
                const prev = rows.get(input.entry_date);
                const row = {
                  entry_date: input.entry_date,
                  payload: copy(input.payload),
                  revision: prev ? prev.revision + 1 : 1,
                  updated_at: new Date().toISOString()
                };
                rows.set(input.entry_date, row);
                return { data: row, error: null };
              }
            })
          })
        };
      }
      return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
    }

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => ({ from: tableApi });
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];

    const blank = () => {
      const e = JSON.parse(JSON.stringify(st.entries[today]));
      Object.values(e.meals).forEach((m) => {
        m.details = ''; m.caloriesOverride = ''; m.macroOverride = '';
      });
      e.weight = '';
      e.steps = '';
      return e;
    };

    // Phone: weight + breakfast, uploaded.
    const phone = blank();
    phone.weight = '84.5';
    phone.meals.breakfast.details = '2 eggs, 1 roti';
    st.entries = { [today]: phone };
    st.syncMeta = { dirty: true, entries: { [today]: {
      dirty: true, localUpdatedAt: new Date().toISOString(), cloudRevision: 0, cloudUpdatedAt: ''
    } } };
    await window.syncTrackerEntries({ silent: true });

    // Laptop: fresh device that only pulls Garmin.
    st.entries = { [today]: blank() };
    st.syncMeta = { dirty: false, entries: {} };
    runtime.conflicts = [];
    window.applyGarminCompanionPayload({
      source: { provider: 'Health Connect' },
      trackerPayloadPatch: { entries: { [today]: { steps: '11200', sleepHours: '7' } } }
    }, { queueRemote: true });
    out.garminMarksDirty = st.syncMeta.entries?.[today]?.dirty === true;

    const laptop = await window.syncTrackerEntries({ silent: true });
    out.laptopReason = laptop.success ? 'ok' : laptop.reason;
    out.laptopWeight = st.entries[today].weight;
    out.laptopBreakfast = st.entries[today].meals.breakfast.details;
    out.laptopSteps = st.entries[today].steps;
    out.cloudWeight = rows.get(today)?.payload?.weight;
    out.cloudBreakfast = rows.get(today)?.payload?.meals?.breakfast?.details;
    out.cloudSteps = rows.get(today)?.payload?.steps;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('Garmin import marks the day for upload', merge.garminMarksDirty === true, JSON.stringify(merge.err || merge.garminMarksDirty));
  check('Garmin-only device does not raise a conflict', merge.laptopReason === 'ok', String(merge.laptopReason));
  check('Garmin pull keeps weight typed on the other device', merge.laptopWeight === '84.5', String(merge.laptopWeight));
  check('Garmin pull keeps meals typed on the other device', merge.laptopBreakfast === '2 eggs, 1 roti', String(merge.laptopBreakfast));
  check('Garmin data survives locally after sync', merge.laptopSteps === '11200', String(merge.laptopSteps));
  check('Garmin data is uploaded for other devices', merge.cloudSteps === '11200', String(merge.cloudSteps));
  check('upload does not erase the other device\'s meals', merge.cloudBreakfast === '2 eggs, 1 roti', String(merge.cloudBreakfast));
  check('upload does not erase the other device\'s weight', merge.cloudWeight === '84.5', String(merge.cloudWeight));

  // --- A never-synced local day must not strand the device ----------------
  // Real-world failure: the laptop had opened today (dirty, cloudRevision 0)
  // while the phone uploaded a full day. Pull skipped the day because it was
  // dirty and push refused it because the cloud revision was ahead, so the
  // laptop reported "synced" while showing none of the phone's data.
  const stranded = await page.evaluate(async () => {
    const out = {};
    const st = window.__trackerTest.getState();
    const runtime = window.__trackerTest.remoteRuntime;
    const origEnsure = window.ensureSupabaseClient;
    const origHasCfg = window.hasRemoteConfig;
    const today = st.selectedDate;
    const rows = new Map();
    const copy = (v) => JSON.parse(JSON.stringify(v));

    function tableApi(table) {
      if (table === 'fitness_tracker_entries') {
        return {
          select: () => {
            let filterDate = null;
            const api = {
              limit: async (n) => ({ data: copy([...rows.values()].slice(0, n)), error: null }),
              order: async () => ({ data: copy([...rows.values()]), error: null }),
              eq: (_c, v) => { filterDate = v; return api; },
              maybeSingle: async () => ({
                data: filterDate && rows.get(filterDate) ? copy(rows.get(filterDate)) : null,
                error: null
              })
            };
            return api;
          },
          upsert: (input) => ({
            select: () => ({
              single: async () => {
                const prev = rows.get(input.entry_date);
                const row = {
                  entry_date: input.entry_date,
                  payload: copy(input.payload),
                  revision: prev ? prev.revision + 1 : 1,
                  updated_at: new Date().toISOString()
                };
                rows.set(input.entry_date, row);
                return { data: row, error: null };
              }
            })
          })
        };
      }
      return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
    }

    window.hasRemoteConfig = () => true;
    window.ensureSupabaseClient = async () => ({ from: tableApi });
    runtime.user = { id: 'u1', email: 'me@example.com' };
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];

    const blank = () => {
      const e = JSON.parse(JSON.stringify(st.entries[today]));
      Object.values(e.meals).forEach((m) => {
        m.details = ''; m.caloriesOverride = ''; m.macroOverride = '';
      });
      (e.exerciseLogs || []).forEach((x) => (x.sets || []).forEach((s) => { s.weight = ''; }));
      e.weight = '';
      e.steps = '';
      e.notes = '';
      e.workoutNotes = '';
      e.waistCm = '';
      e.sleepHours = '';
      e.workoutDone = false;
      return e;
    };

    // Phone uploads a real day.
    const phone = blank();
    phone.weight = '84.5';
    phone.meals.breakfast.details = '2 eggs, 1 roti';
    phone.meals.lunch.details = 'dal chawal';
    st.entries = { [today]: phone };
    st.syncMeta = { dirty: true, entries: { [today]: {
      dirty: true, localUpdatedAt: new Date().toISOString(), cloudRevision: 0, cloudUpdatedAt: ''
    } } };
    await window.syncTrackerEntries({ silent: true });

    // Laptop: opened the day (so it is marked dirty) but typed nothing.
    st.entries = { [today]: blank() };
    st.syncMeta = { dirty: false, entries: {} };
    window.__trackerTest.markEntryDirty(today);
    runtime.conflicts = [];
    out.emptyIsNotUserContent = window.__trackerTest.entryHasUserContent(st.entries[today]) === false;

    const laptop = await window.syncTrackerEntries({ silent: true });
    out.laptopReason = laptop.success ? 'ok' : laptop.reason;
    out.laptopBreakfast = st.entries[today].meals.breakfast.details;
    out.laptopWeight = st.entries[today].weight;
    out.laptopClean = window.__trackerTest.getEntrySyncMeta(today).dirty === false;

    // Now the same situation but the laptop really did type something: that
    // must surface as a conflict rather than silently discarding either side.
    const typed = blank();
    typed.meals.dinner.details = 'laptop only dinner';
    st.entries = { [today]: typed };
    st.syncMeta = { dirty: false, entries: {} };
    window.__trackerTest.markEntryDirty(today);
    runtime.conflicts = [];
    const clash = await window.syncTrackerEntries({ silent: true });
    out.clashReason = clash.success ? 'ok' : clash.reason;
    out.clashKeepsLocal = st.entries[today].meals.dinner.details;
    out.cloudStillHasPhone = rows.get(today)?.payload?.meals?.breakfast?.details;

    window.ensureSupabaseClient = origEnsure;
    window.hasRemoteConfig = origHasCfg;
    runtime.user = null;
    runtime.entrySyncAvailable = null;
    runtime.conflicts = [];
    runtime.dirty = false;
    return out;
  }).catch((e) => ({ err: e.message }));

  check('an untouched day is not treated as user content',
    stranded.emptyIsNotUserContent === true, JSON.stringify(stranded.err || stranded.emptyIsNotUserContent));
  check('never-synced empty day syncs cleanly instead of stranding',
    stranded.laptopReason === 'ok', String(stranded.laptopReason));
  check('second device receives the meals typed on the first',
    stranded.laptopBreakfast === '2 eggs, 1 roti', String(stranded.laptopBreakfast));
  check('second device receives the weight typed on the first',
    stranded.laptopWeight === '84.5', String(stranded.laptopWeight));
  check('downloaded day is no longer marked unsent',
    stranded.laptopClean === true, String(stranded.laptopClean));
  check('genuinely divergent day raises a conflict instead of silence',
    stranded.clashReason === 'conflict', String(stranded.clashReason));
  check('conflict keeps this device\'s typed meal',
    stranded.clashKeepsLocal === 'laptop only dinner', String(stranded.clashKeepsLocal));
  check('conflict leaves the cloud copy intact',
    stranded.cloudStillHasPhone === '2 eggs, 1 roti', String(stranded.cloudStillHasPhone));

  // --- Signing in as a different account must be visible ------------------
  // Real-world failure: a browser was signed in as the wrong address. Its data
  // lived under a separate account, so it reported "Synced" forever while
  // showing none of the other devices' entries.
  const account = await page.evaluate(async () => {
    const out = {};
    const st = window.__trackerTest.getState();
    const runtime = window.__trackerTest.remoteRuntime;
    const origHasCfg = window.hasRemoteConfig;
    const prevEmail = st.remote.email;
    const prevUser = runtime.user;

    window.hasRemoteConfig = () => true;
    st.remote.email = 'me@hotmail.com';
    runtime.user = { id: 'u9', email: 'me@gmail.com' };
    runtime.conflicts = [];
    runtime.tone = 'success';
    out.mismatchDetected = Boolean(window.signedInAccountMismatch());
    out.indicator = window.getSyncIndicatorModel().label;
    window.renderSyncDialog();
    out.warningShown = (document.getElementById('syncAccountWarning')?.textContent || '')
      .includes('me@gmail.com');

    runtime.user = { id: 'u9', email: 'ME@Hotmail.com  ' };
    out.caseInsensitive = window.signedInAccountMismatch() === null;
    window.renderSyncDialog();
    out.warningCleared = (document.getElementById('syncAccountWarning')?.textContent || '').trim() === '';

    st.remote.email = prevEmail;
    runtime.user = prevUser;
    window.hasRemoteConfig = origHasCfg;
    runtime.conflicts = [];
    return out;
  }).catch((e) => ({ err: e.message }));

  check('signed-in account mismatch is detected',
    account.mismatchDetected === true, JSON.stringify(account.err || account.mismatchDetected));
  check('sync indicator reports the wrong account instead of "Synced"',
    account.indicator === 'Wrong account', String(account.indicator));
  check('sync sheet names the account actually signed in',
    account.warningShown === true, String(account.warningShown));
  check('matching account is not flagged, ignoring case and spacing',
    account.caseInsensitive === true, String(account.caseInsensitive));
  check('warning disappears once the account matches',
    account.warningCleared === true, String(account.warningCleared));

  // --- Sync state must be visible in every tab ---------------------------
  // Real-world complaint: on the phone the indicator lived deep in a tall
  // header, so only Summary (which had its own sync card) ever showed it.
  const pinned = [];
  for (const view of ['log', 'progress', 'settings']) {
    const seen = await page.evaluate(async (v) => {
      const st = window.__trackerTest.getState();
      st.currentView = v;
      window.render();
      window.scrollTo(0, 1500);
      await new Promise((r) => setTimeout(r, 60));
      const el = document.getElementById('syncIndicator');
      if (!el) return { ok: false, why: 'missing' };
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        ok: rect.top >= 0 && rect.bottom <= window.innerHeight && (el === hit || el.contains(hit)),
        top: Math.round(rect.top)
      };
    }, view);
    pinned.push({ view, ...seen });
  }
  for (const r of pinned) {
    check(`sync state stays visible when scrolled in the ${r.view} tab`,
      r.ok === true, `top=${r.top}`);
  }
  await page.evaluate(() => { window.scrollTo(0, 0); });

  // --- Information architecture: 3 tabs, no duplicated day content --------
  // The old 4-tab layout rendered daily feedback 3x, the goal intervention 3x
  // and the Garmin card 2x, which is what made the phone view feel cluttered.
  const ia = await page.evaluate(() => {
    const st = window.__trackerTest.getState();
    const tabs = [...document.querySelectorAll('.tab-button')].map((b) => b.dataset.view);
    const countAcrossTabs = (fn) => {
      let total = 0;
      for (const v of tabs) {
        st.currentView = v;
        window.render();
        total += fn(document.getElementById(v + 'View'));
      }
      return total;
    };
    const headings = (root, text) => root
      ? [...root.querySelectorAll('h2, h3')].filter((h) => h.textContent.trim() === text).length
      : 0;
    const result = {
      tabs,
      garminCards: countAcrossTabs((root) => root ? root.querySelectorAll('.garmin-card').length : 0),
      feedbackHeadings: countAcrossTabs((root) => headings(root, 'Feedback')
        + headings(root, 'Smart feedback') + headings(root, "Today's feedback recap")),
      legacyViews: ['dashboardView', 'summaryView'].filter((id) => document.getElementById(id)).length
    };
    st.currentView = 'log';
    window.render();
    return result;
  });
  check('tab bar is exactly Log / Progress / Settings',
    JSON.stringify(ia.tabs) === JSON.stringify(['log', 'progress', 'settings']), JSON.stringify(ia.tabs));
  check('legacy dashboard and summary views are gone',
    ia.legacyViews === 0, String(ia.legacyViews));
  check('Garmin card renders exactly once across all tabs',
    ia.garminCards === 1, String(ia.garminCards));
  check('daily feedback renders exactly once across all tabs',
    ia.feedbackHeadings === 1, String(ia.feedbackHeadings));

  // A saved view name from the old layout must not leave the app blank.
  const migrated = await page.evaluate(() => {
    const st = window.__trackerTest.getState();
    const out = {};
    for (const legacy of ['dashboard', 'summary', 'nonsense']) {
      st.currentView = legacy;
      window.render();
      out[legacy] = {
        resolved: st.currentView,
        visible: [...document.querySelectorAll('.view.active')].length
      };
    }
    st.currentView = 'log';
    window.render();
    return out;
  });
  check('legacy "dashboard" view migrates to Log',
    migrated.dashboard.resolved === 'log' && migrated.dashboard.visible === 1,
    JSON.stringify(migrated.dashboard));
  check('legacy "summary" view migrates to Settings',
    migrated.summary.resolved === 'settings' && migrated.summary.visible === 1,
    JSON.stringify(migrated.summary));
  check('an unknown saved view falls back to Log instead of a blank screen',
    migrated.nonsense.resolved === 'log' && migrated.nonsense.visible === 1,
    JSON.stringify(migrated.nonsense));

  // The date being edited must be pinned next to the sync state, because every
  // tab renders state.selectedDate and past days are editable.
  const dateStrip = await page.evaluate(async () => {
    const st = window.__trackerTest.getState();
    st.currentView = 'log';
    window.render();
    window.scrollTo(0, 1500);
    await new Promise((r) => setTimeout(r, 60));
    const label = document.getElementById('dateStripPrimary');
    if (!label) return { ok: false, why: 'missing' };
    const rect = label.getBoundingClientRect();
    return {
      ok: rect.top >= 0 && rect.bottom <= window.innerHeight,
      text: label.textContent.trim(),
      secondary: document.getElementById('dateStripSecondary')?.textContent.trim(),
      todayHidden: document.getElementById('dateStripToday')?.hidden
    };
  });
  check('selected date stays pinned on screen while scrolling',
    dateStrip.ok === true && dateStrip.text.length > 0, JSON.stringify(dateStrip));
  check('date strip says how far the selected day is from today',
    typeof dateStrip.secondary === 'string' && dateStrip.secondary.length > 0,
    JSON.stringify(dateStrip.secondary));
  check('"Back to today" offered when not viewing today',
    dateStrip.todayHidden === false, String(dateStrip.todayHidden));
  await page.evaluate(() => { window.scrollTo(0, 0); });

  // Targets moved to Settings, so they have to actually be editable there.
  const targets = await page.evaluate(() => {
    const st = window.__trackerTest.getState();
    st.currentView = 'settings';
    window.render();
    const input = document.querySelector('[data-profile-field="proteinTarget"]');
    if (!input) return { ok: false, why: 'missing' };
    const before = st.profile.proteinTarget;
    input.value = '155';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const after = window.__trackerTest.getState().profile.proteinTarget;
    st.profile.proteinTarget = before;
    st.currentView = 'log';
    window.render();
    return { ok: true, before, after };
  });
  check('protein target is editable from the Settings tab',
    targets.ok === true && targets.after === 155, JSON.stringify(targets));

  // Metric tiles collapsing to one column is what made Progress endless.
  const tileColumns = await page.evaluate(() => {
    const st = window.__trackerTest.getState();
    st.currentView = 'progress';
    window.render();
    const grid = document.querySelector('#progressView .metric-grid');
    if (!grid) return { ok: false, why: 'missing' };
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    st.currentView = 'log';
    window.render();
    return { ok: true, cols, width: window.innerWidth };
  });
  check('metric tiles are at least 2-up instead of one per row',
    tileColumns.ok === true && tileColumns.cols >= 2,
    JSON.stringify(tileColumns));

  await browser.close();

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -> ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
