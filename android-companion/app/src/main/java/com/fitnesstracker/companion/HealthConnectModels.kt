package com.fitnesstracker.companion

import kotlinx.serialization.Serializable

enum class HealthConnectSdkStatus {
    AVAILABLE,
    UPDATE_REQUIRED,
    UNAVAILABLE
}

@Serializable
data class HealthConnectExport(
    val schemaVersion: Int = 1,
    val exportedAt: String,
    val source: ExportSource,
    val selectedRange: ExportDateRange,
    val trackerPayloadPatch: TrackerPayloadPatch,
    val dailySummaries: List<HealthConnectDailySummary>,
    val recordCounts: HealthConnectRecordCounts
)

@Serializable
data class ExportSource(
    val app: String = "fitness-tracker-android-companion",
    val provider: String = "Health Connect",
    val providerPackage: String = "com.google.android.apps.healthdata",
    val targetDevice: String = "OnePlus 12 / OxygenOS 16",
    val transport: String = "Local JSON export or authenticated Supabase REST sync",
    val excludes: List<String> = listOf(
        "Garmin credentials",
        "Bluetooth pairing",
        "Unofficial Garmin APIs"
    )
)

@Serializable
data class ExportDateRange(
    val startDate: String,
    val endDate: String
)

@Serializable
data class TrackerPayloadPatch(
    val trackerVersion: Int,
    val trackerStartDate: String,
    val generatedAt: String,
    val entries: Map<String, TrackerEntryPatch>
)

@Serializable
data class TrackerEntryPatch(
    val weight: String? = null,
    val steps: String? = null,
    val sleepHours: String? = null,
    val cardioType: String? = null,
    val cardioDuration: String? = null,
    val cardioCalories: String? = null,
    val workoutDone: Boolean? = null,
    val workoutNotes: String? = null
)

@Serializable
data class HealthConnectDailySummary(
    val date: String,
    val steps: Long = 0,
    val distanceKm: Double = 0.0,
    val activeCaloriesKcal: Double = 0.0,
    val totalCaloriesKcal: Double = 0.0,
    val averageHeartRateBpm: Double? = null,
    val minHeartRateBpm: Long? = null,
    val maxHeartRateBpm: Long? = null,
    val heartRateSampleCount: Int = 0,
    val averageRestingHeartRateBpm: Double? = null,
    val restingHeartRateSampleCount: Int = 0,
    val sleepHours: Double = 0.0,
    val sleepSessionCount: Int = 0,
    val latestWeightKg: Double? = null,
    val weightSampleCount: Int = 0,
    val latestBodyFatPercent: Double? = null,
    val bodyFatSampleCount: Int = 0,
    val exerciseMinutes: Long = 0,
    val exerciseCaloriesKcal: Double = 0.0,
    val exerciseDistanceKm: Double = 0.0,
    val exerciseSessionCount: Int = 0,
    val exerciseSessions: List<ExerciseSessionSummary> = emptyList()
) {
    fun hasAnyData(): Boolean {
        return steps > 0 ||
            distanceKm > 0 ||
            activeCaloriesKcal > 0 ||
            totalCaloriesKcal > 0 ||
            heartRateSampleCount > 0 ||
            restingHeartRateSampleCount > 0 ||
            sleepSessionCount > 0 ||
            weightSampleCount > 0 ||
            bodyFatSampleCount > 0 ||
            exerciseSessionCount > 0
    }
}

@Serializable
data class ExerciseSessionSummary(
    val title: String,
    val startTime: String,
    val endTime: String,
    val durationMinutes: Long,
    val caloriesKcal: Double? = null,
    val distanceKm: Double? = null,
    val notes: String? = null
)

@Serializable
data class HealthConnectRecordCounts(
    val stepsRecords: Int = 0,
    val distanceRecords: Int = 0,
    val activeCaloriesRecords: Int = 0,
    val totalCaloriesRecords: Int = 0,
    val heartRateRecords: Int = 0,
    val restingHeartRateRecords: Int = 0,
    val sleepSessionRecords: Int = 0,
    val weightRecords: Int = 0,
    val bodyFatRecords: Int = 0,
    val exerciseSessionRecords: Int = 0
) {
    fun total(): Int {
        return stepsRecords +
            distanceRecords +
            activeCaloriesRecords +
            totalCaloriesRecords +
            heartRateRecords +
            restingHeartRateRecords +
            sleepSessionRecords +
            weightRecords +
            bodyFatRecords +
            exerciseSessionRecords
    }
}

data class HealthConnectSnapshot(
    val exportedAt: String,
    val selectedRange: ExportDateRange,
    val dailySummaries: List<HealthConnectDailySummary>,
    val recordCounts: HealthConnectRecordCounts
)
