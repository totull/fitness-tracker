package com.fitnesstracker.companion

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.roundToLong

object HealthConnectNormalizer {
    const val WEB_TRACKER_VERSION = 5
    const val WEB_TRACKER_START_DATE = "2026-03-24"

    fun toExport(snapshot: HealthConnectSnapshot): HealthConnectExport {
        val entries = linkedMapOf<String, TrackerEntryPatch>()

        snapshot.dailySummaries
            .sortedBy { it.date }
            .filter { it.date >= WEB_TRACKER_START_DATE }
            .forEach { summary ->
                val entry = toTrackerEntry(summary)
                if (entry != null) {
                    entries[summary.date] = entry
                }
            }

        return HealthConnectExport(
            exportedAt = snapshot.exportedAt,
            source = ExportSource(),
            selectedRange = snapshot.selectedRange,
            trackerPayloadPatch = TrackerPayloadPatch(
                trackerVersion = WEB_TRACKER_VERSION,
                trackerStartDate = WEB_TRACKER_START_DATE,
                generatedAt = snapshot.exportedAt,
                entries = entries
            ),
            dailySummaries = snapshot.dailySummaries.sortedBy { it.date },
            recordCounts = snapshot.recordCounts
        )
    }

    private fun toTrackerEntry(summary: HealthConnectDailySummary): TrackerEntryPatch? {
        val hasWorkout = summary.exerciseSessionCount > 0 || summary.exerciseMinutes > 0
        val notes = buildWorkoutNotes(summary)
        val cardioCalories = when {
            summary.exerciseCaloriesKcal > 0 -> summary.exerciseCaloriesKcal.roundToLong().toString()
            summary.activeCaloriesKcal > 0 && hasWorkout -> summary.activeCaloriesKcal.roundToLong().toString()
            else -> null
        }

        val entry = TrackerEntryPatch(
            weight = summary.latestWeightKg?.format(1),
            steps = summary.steps.takeIf { it > 0 }?.toString(),
            sleepHours = summary.sleepHours.takeIf { it > 0 }?.format(1),
            cardioType = when {
                !hasWorkout -> null
                summary.exerciseSessionCount == 1 -> summary.exerciseSessions.firstOrNull()?.title ?: "Exercise session"
                else -> "Health Connect sessions"
            },
            cardioDuration = summary.exerciseMinutes.takeIf { it > 0 }?.toString(),
            cardioCalories = cardioCalories,
            workoutDone = hasWorkout.takeIf { hasWorkout },
            workoutNotes = notes
        )

        return if (entry == TrackerEntryPatch()) null else entry
    }

    private fun buildWorkoutNotes(summary: HealthConnectDailySummary): String? {
        val parts = mutableListOf<String>()
        if (summary.distanceKm > 0) {
            parts += "Distance ${summary.distanceKm.format(1)} km"
        }
        if (summary.activeCaloriesKcal > 0) {
            parts += "Active ${summary.activeCaloriesKcal.format(0)} kcal"
        }
        if (summary.totalCaloriesKcal > 0) {
            parts += "Total ${summary.totalCaloriesKcal.format(0)} kcal"
        }
        if (summary.averageHeartRateBpm != null) {
            parts += "Avg HR ${summary.averageHeartRateBpm.format(1)} bpm"
        }
        if (summary.averageRestingHeartRateBpm != null) {
            parts += "Resting HR ${summary.averageRestingHeartRateBpm.format(1)} bpm"
        }
        if (summary.latestBodyFatPercent != null) {
            parts += "Body fat ${summary.latestBodyFatPercent.format(1)}%"
        }
        if (summary.exerciseSessions.isNotEmpty()) {
            val sessions = summary.exerciseSessions.joinToString("; ") {
                "${it.title} ${it.durationMinutes}m"
            }
            parts += "Sessions: $sessions"
        }
        return if (parts.isEmpty()) null else "Imported from Health Connect. ${parts.joinToString(". ")}."
    }

    private fun Double.format(scale: Int): String {
        return BigDecimal.valueOf(this)
            .setScale(scale, RoundingMode.HALF_UP)
            .stripTrailingZeros()
            .toPlainString()
    }
}

