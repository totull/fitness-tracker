# Task: periodic background sync in the companion app

Hand-off from the tracker session. The web tracker now auto-pulls from Supabase
on page load and on tab focus (throttled to 15 minutes). What is missing is the
other half: the companion must upload **on its own schedule** so there is
something fresh to pull. Today it only uploads when the user taps
"Sync to tracker".

Goal: the user opens the tracker and the data is already current, with no taps
on either device.

## Environment note

This task requires a working Android toolchain (`JAVA_HOME`, Android SDK,
`gradlew`). The tracker session does **not** have Java available and cannot
build or verify the APK — that is why this is being handed over.

## Scope

### 1. Add WorkManager

`app/build.gradle.kts`:

```kotlin
implementation("androidx.work:work-runtime-ktx:2.9.1")
```

### 2. Declare and request background health reads

Background Health Connect reads need their own permission. The existing
`READ_STEPS` / `READ_SLEEP` / etc. grants do **not** cover reads that happen
while the app is not foregrounded — the worker will fail without this.

`AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND" />
```

It must also be **requested at runtime** and added to the permission set the app
asks for. `minSdk` is already 34, which supports it. Surface the grant state in
the UI so the user can tell whether background sync can actually work — a silent
denial here is the most likely cause of "it stopped syncing".

### 3. Add a periodic worker

New file `app/src/main/java/com/fitnesstracker/companion/GarminSyncWorker.kt`:

- `CoroutineWorker` that reuses the existing pipeline. Do **not** duplicate the
  export or upload logic — factor the shared part out of
  `HealthConnectCompanionViewModel.syncToTracker()` so the worker and the button
  run the same code path.
- Read config and session from `supabaseSessionStore`.
- Refresh the token when near expiry via `SupabaseSyncClient.refreshSession()`,
  and persist the refreshed session. An 8-hour cadence means the access token
  will essentially always be expired on entry, so this path must work — it is
  the most likely silent failure.
- Return `Result.retry()` on network/5xx, `Result.failure()` on auth failure
  that a retry cannot fix, `Result.success()` on upload.

Schedule:

```kotlin
PeriodicWorkRequestBuilder<GarminSyncWorker>(8, TimeUnit.HOURS)
    .setConstraints(
        Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
    )
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
    .build()
```

Enqueue with `ExistingPeriodicWorkPolicy.UPDATE` and a stable unique name
(`garmin-periodic-sync`) so repeated app launches do not stack duplicates.
Enqueue once the user is signed in; cancel it on sign-out or when the Supabase
config is cleared.

### 4. Sync on app open

Trigger a one-shot sync when the app comes to the foreground and the last
successful upload is older than ~1 hour. Reuse the same shared path.

### 5. Surface last-sync state in the UI

Persist `lastSuccessfulSyncAt` and show it on the Supabase card, plus the last
error if the most recent attempt failed. Without this, a worker silently killed
by the OS is invisible to the user.

## OnePlus 12 / OxygenOS caveat — call this out in the UI

OxygenOS is aggressive about killing deferred background work, and an 8-hour
`PeriodicWorkRequest` is a prime target. Expect syncs to stop unless the app is
exempted from battery optimisation.

Add a one-time prompt or a settings hint pointing the user to
**Settings → Battery → App battery usage → Fitness Tracker Companion →
Unrestricted** (wording varies by OxygenOS version). Consider
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, but note Play Store policy
restricts that intent, so a hint plus deep link to battery settings is the safer
route for a sideloaded personal app.

## Testing

Unit-testable without a device, and worth covering:

- Token refresh triggers when `expiresAtEpochSeconds` is near/past.
- Worker returns `retry` on transient failure and `failure` on hard auth errors.
- Scheduling is idempotent — enqueueing twice yields one unique work entry.
- `HealthConnectNormalizerTest` still passes.

On-device verification (cannot be done from the tracker session):

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Force the periodic worker without waiting 8 hours:
adb shell cmd jobscheduler run -f com.fitnesstracker.companion <jobId>
# or inspect scheduled work:
adb shell dumpsys jobscheduler | grep -A5 fitnesstracker
```

Confirm end-to-end by checking the row actually moved, in the Supabase SQL
editor:

```sql
select u.email, g.updated_at
from public.fitness_tracker_garmin_sync g
join auth.users u on u.id = g.user_id
order by g.updated_at desc;
```

`updated_at` must advance without anyone tapping "Sync to tracker".

## Account context (important)

The user has two Supabase identities:

- `npande77@hotmail.com` — the tracker's account, holds `fitness_tracker_state`.
  **This is the correct one.**
- `npande77@gmail.com` — what the companion was signed in as, which is why the
  first end-to-end attempt silently returned no rows.

The companion should be signed in as **hotmail**. Changing the email field
already clears the stored session (`updateSupabaseEmail` → `clearSession()`), so
no schema change is needed; rows are keyed by `user_id`.

Worth considering as part of this task: show the signed-in email prominently on
the Supabase card, since an account mismatch is silent and cost real debugging
time.

## Do not change

- `Tracker.html`, `tools/`, or `supabase-schema.sql` — owned by the tracker
  session; the schema already supports this and needs no migration.
- The `HealthConnectExport` JSON contract — the web tracker parses
  `payload.trackerPayloadPatch.entries` and will break if the shape changes.
