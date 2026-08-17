package com.fitnesstracker.companion

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

object GarminSyncScheduler {
    const val PERIODIC_WORK_NAME = "garmin-periodic-sync"
    private const val FOREGROUND_WORK_NAME = "garmin-foreground-sync"

    fun enqueuePeriodic(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = PeriodicWorkRequestBuilder<GarminSyncWorker>(4, TimeUnit.HOURS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    fun enqueueForegroundIfStale(context: Context, lastSuccessfulSyncAt: String?) {
        val lastSync = lastSuccessfulSyncAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        if (lastSync != null && Duration.between(lastSync, Instant.now()).toMinutes() < 60) {
            return
        }
        val request = OneTimeWorkRequestBuilder<GarminSyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            FOREGROUND_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request
        )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK_NAME)
        WorkManager.getInstance(context).cancelUniqueWork(FOREGROUND_WORK_NAME)
    }
}
