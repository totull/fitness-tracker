package com.fitnesstracker.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.reflect.KClass

class HealthConnectRepository(context: Context) {
    private val appContext = context.applicationContext
    private val zoneId = ZoneId.systemDefault()

    private val client: HealthConnectClient by lazy {
        HealthConnectClient.getOrCreate(appContext)
    }

    fun context(): Context = appContext

    fun requiredPermissions(): Set<String> {
        return linkedSetOf(
            BACKGROUND_PERMISSION,
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(DistanceRecord::class),
            HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(RestingHeartRateRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(WeightRecord::class),
            HealthPermission.getReadPermission(BodyFatRecord::class),
            HealthPermission.getReadPermission(ExerciseSessionRecord::class)
        )
    }

    companion object {
        const val BACKGROUND_PERMISSION = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    }

    fun sdkStatus(): HealthConnectSdkStatus {
        return when (HealthConnectClient.getSdkStatus(appContext)) {
            HealthConnectClient.SDK_AVAILABLE -> HealthConnectSdkStatus.AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> HealthConnectSdkStatus.UPDATE_REQUIRED
            else -> HealthConnectSdkStatus.UNAVAILABLE
        }
    }

    suspend fun getGrantedPermissions(): Set<String> {
        if (sdkStatus() != HealthConnectSdkStatus.AVAILABLE) {
            return emptySet()
        }
        return client.permissionController.getGrantedPermissions()
    }

    suspend fun readSnapshot(startDate: LocalDate, endDate: LocalDate): HealthConnectSnapshot {
        require(!endDate.isBefore(startDate)) { "End date must be on or after start date." }

        val granted = getGrantedPermissions()
        val missing = requiredPermissions() - granted
        require(missing.isEmpty()) {
            "Missing Health Connect permissions: ${missing.joinToString()}"
        }

        val startInstant = startDate.atStartOfDay(zoneId).toInstant()
        val endExclusiveInstant = endDate.plusDays(1).atStartOfDay(zoneId).toInstant()
        val filter = TimeRangeFilter.between(startInstant, endExclusiveInstant)
        val buckets = linkedMapOf<LocalDate, MutableDailySummary>()

        val steps = readDailyStepTotals(startDate, endDate)
        val distances = readAllRecords(DistanceRecord::class, filter)
        val activeCalories = readAllRecords(ActiveCaloriesBurnedRecord::class, filter)
        val totalCalories = readAllRecords(TotalCaloriesBurnedRecord::class, filter)
        val heartRates = readAllRecords(HeartRateRecord::class, filter)
        val restingHeartRates = readAllRecords(RestingHeartRateRecord::class, filter)
        val sleepSessions = readAllRecords(SleepSessionRecord::class, filter)
        val weights = readAllRecords(WeightRecord::class, filter)
        val bodyFat = readAllRecords(BodyFatRecord::class, filter)
        val exerciseSessions = readAllRecords(ExerciseSessionRecord::class, filter)

        steps.forEach { (date, count) ->
            bucket(buckets, date).steps += count
        }

        distances.forEach { record ->
            bucket(buckets, record.startTime.toLocalDate()).distanceKm += record.distance.inKilometers
        }

        activeCalories.forEach { record ->
            bucket(buckets, record.startTime.toLocalDate()).activeCaloriesKcal += record.energy.inKilocalories
        }

        totalCalories.forEach { record ->
            bucket(buckets, record.startTime.toLocalDate()).totalCaloriesKcal += record.energy.inKilocalories
        }

        heartRates.forEach { record ->
            record.samples.forEach { sample ->
                bucket(buckets, sample.time.toLocalDate()).heartRateStats.add(sample.beatsPerMinute.toDouble())
            }
        }

        restingHeartRates.forEach { record ->
            bucket(buckets, record.time.toLocalDate()).restingHeartRateStats.add(record.beatsPerMinute.toDouble())
        }

        sleepSessions.forEach { record ->
            val daily = bucket(buckets, record.endTime.toLocalDate())
            daily.sleepHours += Duration.between(record.startTime, record.endTime).toMinutes().coerceAtLeast(0) / 60.0
            daily.sleepSessionCount += 1
        }

        weights.forEach { record ->
            bucket(buckets, record.time.toLocalDate()).applyWeight(record.time, record.weight.inKilograms)
        }

        bodyFat.forEach { record ->
            bucket(buckets, record.time.toLocalDate()).applyBodyFat(record.time, record.percentage.value)
        }

        exerciseSessions.forEach { record ->
            val daily = bucket(buckets, record.startTime.toLocalDate())
            val durationMinutes = Duration.between(record.startTime, record.endTime).toMinutes().coerceAtLeast(0)
            daily.exerciseMinutes += durationMinutes
            daily.exerciseSessions += ExerciseSessionSummary(
                title = record.title?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: record.notes?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: "Exercise session",
                startTime = record.startTime.toString(),
                endTime = record.endTime.toString(),
                durationMinutes = durationMinutes,
                notes = record.notes?.toString()?.trim()?.takeIf { it.isNotEmpty() }
            )
        }

        val summaries = buckets.values
            .map { it.toImmutable() }
            .filter { it.hasAnyData() }
            .sortedBy { it.date }

        return HealthConnectSnapshot(
            exportedAt = Instant.now().toString(),
            selectedRange = ExportDateRange(
                startDate = startDate.toString(),
                endDate = endDate.toString()
            ),
            dailySummaries = summaries,
            recordCounts = HealthConnectRecordCounts(
                stepsRecords = 0,
                distanceRecords = distances.size,
                activeCaloriesRecords = activeCalories.size,
                totalCaloriesRecords = totalCalories.size,
                heartRateRecords = heartRates.size,
                restingHeartRateRecords = restingHeartRates.size,
                sleepSessionRecords = sleepSessions.size,
                weightRecords = weights.size,
                bodyFatRecords = bodyFat.size,
                exerciseSessionRecords = exerciseSessions.size
            )
        )
    }

    private suspend fun readDailyStepTotals(
        startDate: LocalDate,
        endDate: LocalDate
    ): Map<LocalDate, Long> {
        val totals = linkedMapOf<LocalDate, Long>()
        var date = startDate
        while (!date.isAfter(endDate)) {
            val dayStart = date.atStartOfDay(zoneId).toInstant()
            val dayEnd = date.plusDays(1).atStartOfDay(zoneId).toInstant()
            val result = client.aggregate(
                AggregateRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL),
                    timeRangeFilter = TimeRangeFilter.between(dayStart, dayEnd)
                )
            )
            val count = result[StepsRecord.COUNT_TOTAL] ?: 0L
            if (count > 0) {
                totals[date] = count
            }
            date = date.plusDays(1)
        }
        return totals
    }

    private suspend fun <T : Record> readAllRecords(
        recordType: KClass<T>,
        filter: TimeRangeFilter
    ): List<T> {
        return try {
            val records = mutableListOf<T>()
            var pageToken: String? = null

            do {
                val response = client.readRecords(
                    ReadRecordsRequest(
                        recordType = recordType,
                        timeRangeFilter = filter,
                        ascendingOrder = true,
                        pageSize = 1000,
                        pageToken = pageToken
                    )
                )
                records += response.records
                pageToken = response.pageToken
            } while (pageToken != null)

            records
        } catch (error: Exception) {
            throw IllegalStateException(
                "Unable to read ${recordType.simpleName}: ${error.message}",
                error
            )
        }
    }

    private fun bucket(
        buckets: MutableMap<LocalDate, MutableDailySummary>,
        date: LocalDate
    ): MutableDailySummary {
        return buckets.getOrPut(date) { MutableDailySummary(date.toString()) }
    }

    private fun Instant.toLocalDate(): LocalDate {
        return atZone(zoneId).toLocalDate()
    }

    private class MutableDailySummary(
        private val date: String,
        var steps: Long = 0,
        var distanceKm: Double = 0.0,
        var activeCaloriesKcal: Double = 0.0,
        var totalCaloriesKcal: Double = 0.0,
        var sleepHours: Double = 0.0,
        var sleepSessionCount: Int = 0,
        var exerciseMinutes: Long = 0,
        var exerciseCaloriesKcal: Double = 0.0,
        var exerciseDistanceKm: Double = 0.0,
        val exerciseSessions: MutableList<ExerciseSessionSummary> = mutableListOf(),
        val heartRateStats: RunningStats = RunningStats(),
        val restingHeartRateStats: RunningStats = RunningStats()
    ) {
        private var latestWeightTime: Instant? = null
        private var latestWeightKg: Double? = null
        private var weightSampleCount: Int = 0

        private var latestBodyFatTime: Instant? = null
        private var latestBodyFatPercent: Double? = null
        private var bodyFatSampleCount: Int = 0

        fun applyWeight(time: Instant, kilograms: Double) {
            weightSampleCount += 1
            if (latestWeightTime == null || time.isAfter(latestWeightTime)) {
                latestWeightTime = time
                latestWeightKg = kilograms
            }
        }

        fun applyBodyFat(time: Instant, percent: Double) {
            bodyFatSampleCount += 1
            if (latestBodyFatTime == null || time.isAfter(latestBodyFatTime)) {
                latestBodyFatTime = time
                latestBodyFatPercent = percent
            }
        }

        fun toImmutable(): HealthConnectDailySummary {
            return HealthConnectDailySummary(
                date = date,
                steps = steps,
                distanceKm = distanceKm,
                activeCaloriesKcal = activeCaloriesKcal,
                totalCaloriesKcal = totalCaloriesKcal,
                averageHeartRateBpm = heartRateStats.average(),
                minHeartRateBpm = heartRateStats.minValue?.toLong(),
                maxHeartRateBpm = heartRateStats.maxValue?.toLong(),
                heartRateSampleCount = heartRateStats.count,
                averageRestingHeartRateBpm = restingHeartRateStats.average(),
                restingHeartRateSampleCount = restingHeartRateStats.count,
                sleepHours = sleepHours,
                sleepSessionCount = sleepSessionCount,
                latestWeightKg = latestWeightKg,
                weightSampleCount = weightSampleCount,
                latestBodyFatPercent = latestBodyFatPercent,
                bodyFatSampleCount = bodyFatSampleCount,
                exerciseMinutes = exerciseMinutes,
                exerciseCaloriesKcal = exerciseCaloriesKcal,
                exerciseDistanceKm = exerciseDistanceKm,
                exerciseSessionCount = exerciseSessions.size,
                exerciseSessions = exerciseSessions.sortedBy { it.startTime }
            )
        }
    }

    private class RunningStats {
        var count: Int = 0
            private set
        var minValue: Double? = null
            private set
        var maxValue: Double? = null
            private set
        private var sum: Double = 0.0

        fun add(value: Double) {
            count += 1
            sum += value
            minValue = minValue?.coerceAtMost(value) ?: value
            maxValue = maxValue?.coerceAtLeast(value) ?: value
        }

        fun average(): Double? {
            return if (count == 0) null else sum / count
        }
    }
}
