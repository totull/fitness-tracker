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
  await page.locator('.tab-button[data-view="summary"]').click();
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

  await browser.close();

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -> ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
