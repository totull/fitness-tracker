# Android companion scaffold

This folder adds a **small Android companion app scaffold** for the existing `fitness-tracker` web app.

## Scope

- Reads **user-consented Health Connect data only**
- Supports:
  - steps
  - distance
  - active calories
  - total calories
  - heart rate
  - resting heart rate
  - sleep
  - weight
  - body fat
  - exercise sessions
- Normalizes a **JSON export boundary** for the current web tracker payload shape
- Can authenticate to Supabase with an email OTP and upload the export directly
- Schedules an authenticated Health Connect upload about every 4 hours and catches up when the app opens
- Keeps the existing document-picker JSON export flow
- **Does not** handle Garmin credentials, Bluetooth pairing, or unofficial Garmin APIs

## Supabase sync

The app uses `HttpURLConnection` and the Supabase REST/Auth endpoints; no Supabase Android SDK is required. The uploaded row contains:

- `user_id` — the authenticated Supabase user ID (the table primary key)
- `payload` — the complete `HealthConnectExport` JSON object
- `updated_at` — the export timestamp

Run the SQL in the repository root `supabase-schema.sql` in the Supabase SQL editor. It creates `fitness_tracker_garmin_sync`, enables RLS, and limits each row to its authenticated owner. Enable email OTP in Supabase Auth, then enter the project URL, anon key, and email in the Android app. Tap **Request OTP**, enter the code, and tap **Verify OTP**. The app persists this configuration and session, schedules background uploads about every 4 hours, and catches up when opened. Sync builds the current Health Connect export in memory and uploads it without creating a local JSON file.

The web tracker can pull the row from its existing `fitness_tracker_state` flow only after a separate import/integration step; this Android sync does not modify `Tracker.html`.

## Folder layout

- `app/` — Android app module
- `app/src/main/java/com/fitnesstracker/companion/`
  - `MainActivity.kt` — Compose UI
  - `HealthConnectCompanionViewModel.kt` — screen state and export flow
  - `HealthConnectRepository.kt` — Health Connect reads
  - `HealthConnectNormalizer.kt` — maps Health Connect summaries to the web tracker's payload
  - `HealthConnectModels.kt` — export models
  - `ExportWriter.kt` — saves JSON through the Android document picker
  - `SupabaseSyncClient.kt` — email OTP and authenticated REST upload

## Export contract

The app writes a JSON document with:

- `trackerPayloadPatch`
  - `trackerVersion: 5`
  - `trackerStartDate: "2026-03-24"`
  - `entries: { "YYYY-MM-DD": { ...web tracker entry patch... } }`
- `dailySummaries`
  - compact per-day Health Connect summaries
- `recordCounts`
  - how many raw records were read per record type

### Current web-tracker field mapping

The normalized `entries` patch targets the current `Tracker.html` model:

- `weight`
- `steps`
- `sleepHours`
- `cardioType`
- `cardioDuration`
- `cardioCalories`
- `workoutDone`
- `workoutNotes`

Heart rate, resting HR, distance, body-fat, and calorie details are preserved in:

- `dailySummaries`
- `workoutNotes` for each exported tracker entry

## Target device

This scaffold is intentionally narrow:

- **OnePlus 12**
- **OxygenOS 16**
- modern Android/Health Connect environment

The app uses `minSdk 34` to stay focused on recent platform behavior instead of older-device compatibility.

## Local build

The project includes a Gradle 8.7 wrapper and builds with:

- JDK 17
- Android SDK Platform 35
- Android SDK Build-Tools 35.0.0
- Android SDK Platform-Tools

Run:

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug
```

The debug APK is written to:

```text
app\build\outputs\apk\debug\app-debug.apk
```

## Device validation

1. Install the debug APK on the OnePlus 12.
2. Grant the requested Health Connect permissions.
3. Generate an export and verify the JSON, or configure Supabase and complete the OTP flow.
4. Tap **Sync to tracker** to upload the in-memory export.

Suggested checks:

- permission dialog appears
- Health Connect data loads for the selected range
- JSON file is written through the Android document picker
- `trackerPayloadPatch.entries` contains the expected days and values
- Supabase RLS accepts an authenticated upsert to `fitness_tracker_garmin_sync`

## Caveats

- The project URL, anon key, and email are saved in app-private storage for future launches. After OTP verification, the authenticated session and refresh token are also saved so normal syncs do not require signing in again; changing any saved configuration clears the session.
- Background sync additionally requires `READ_HEALTH_DATA_IN_BACKGROUND` and an unrestricted battery setting on OnePlus/OxygenOS.
- OTP verification depends on Supabase email OTP being enabled and the email provider being configured.
- A Java 17/Android SDK 35 environment is required for the Gradle build; if Java is unavailable, the Kotlin changes can still be reviewed without running Gradle.
