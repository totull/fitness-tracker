package com.fitnesstracker.companion

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.IOException

class GarminSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        Log.i(TAG, "Background sync worker fired: id=$id")
        val store = SupabaseSessionStore(applicationContext)
        val saved = store.load()
        val session = saved.session
        if (saved.url.isBlank() || saved.anonKey.isBlank() || session == null) {
            Log.w(TAG, "Background sync skipped because Supabase is not signed in.")
            return Result.failure()
        }

        return try {
            GarminSyncCoordinator(
                repository = HealthConnectRepository(applicationContext),
                supabaseSyncClient = SupabaseSyncClient(),
                supabaseSessionStore = store
            ).sync(saved.url, saved.anonKey, session)
            Log.i(TAG, "Background sync upload succeeded.")
            Result.success()
        } catch (error: SupabaseRequestException) {
            store.saveSyncError(error.message ?: "Supabase request failed.")
            when {
                error.statusCode == 401 || error.statusCode == 403 -> Result.failure()
                error.statusCode >= 500 -> Result.retry()
                else -> Result.failure()
            }
        } catch (error: IOException) {
            store.saveSyncError(error.message ?: "Network sync failed.")
            Result.retry()
        } catch (error: IllegalStateException) {
            store.saveSyncError(error.message ?: "Health Connect sync failed.")
            Result.failure()
        } catch (error: Exception) {
            store.saveSyncError(error.message ?: "Background sync failed.")
            Result.retry()
        }
    }

    private companion object {
        const val TAG = "GarminSyncWorker"
    }
}
