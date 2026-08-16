package com.fitnesstracker.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthConnectNormalizerTest {
    @Test
    fun normalizerCreatesTrackerPatchForRelevantDay() {
        val snapshot = HealthConnectSnapshot(
            exportedAt = "2026-08-16T05:30:00Z",
            selectedRange = ExportDateRange(
                startDate = "2026-08-10",
                endDate = "2026-08-16"
            ),
            dailySummaries = listOf(
                HealthConnectDailySummary(
                    date = "2026-08-16",
                    steps = 9321,
                    distanceKm = 6.9,
                    activeCaloriesKcal = 411.0,
                    totalCaloriesKcal = 2234.0,
                    averageHeartRateBpm = 128.4,
                    heartRateSampleCount = 18,
                    averageRestingHeartRateBpm = 57.0,
                    restingHeartRateSampleCount = 1,
                    sleepHours = 7.3,
                    sleepSessionCount = 1,
                    latestWeightKg = 85.7,
                    weightSampleCount = 1,
                    latestBodyFatPercent = 22.1,
                    bodyFatSampleCount = 1,
                    exerciseMinutes = 42,
                    exerciseCaloriesKcal = 318.0,
                    exerciseSessionCount = 1,
                    exerciseSessions = listOf(
                        ExerciseSessionSummary(
                            title = "Evening walk",
                            startTime = "2026-08-16T12:00:00Z",
                            endTime = "2026-08-16T12:42:00Z",
                            durationMinutes = 42
                        )
                    )
                )
            ),
            recordCounts = HealthConnectRecordCounts(stepsRecords = 2, heartRateRecords = 3)
        )

        val export = HealthConnectNormalizer.toExport(snapshot)
        val entry = export.trackerPayloadPatch.entries.getValue("2026-08-16")

        assertEquals("85.7", entry.weight)
        assertEquals("9321", entry.steps)
        assertEquals("7.3", entry.sleepHours)
        assertEquals("Evening walk", entry.cardioType)
        assertEquals("42", entry.cardioDuration)
        assertEquals("318", entry.cardioCalories)
        assertTrue(entry.workoutDone == true)
        assertTrue(entry.workoutNotes.orEmpty().contains("Avg HR 128.4 bpm"))
    }

    @Test
    fun normalizerSkipsDaysBeforeCurrentWebTrackerBaseline() {
        val snapshot = HealthConnectSnapshot(
            exportedAt = "2026-08-16T05:30:00Z",
            selectedRange = ExportDateRange(
                startDate = "2026-03-01",
                endDate = "2026-03-20"
            ),
            dailySummaries = listOf(
                HealthConnectDailySummary(
                    date = "2026-03-10",
                    steps = 5000
                )
            ),
            recordCounts = HealthConnectRecordCounts(stepsRecords = 1)
        )

        val export = HealthConnectNormalizer.toExport(snapshot)

        assertTrue(export.trackerPayloadPatch.entries.isEmpty())
        assertFalse(export.dailySummaries.isEmpty())
    }
}
