package com.fitnesstracker.companion

import java.time.Instant
import java.time.LocalDate
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class SyncOutcome(
    val export: HealthConnectExport,
    val preview: String,
    val session: SupabaseSession
)

class GarminSyncCoordinator(
    private val repository: HealthConnectRepository,
    private val supabaseSyncClient: SupabaseSyncClient,
    private val supabaseSessionStore: SupabaseSessionStore,
    private val json: Json = Json {
        prettyPrint = true
        encodeDefaults = true
        explicitNulls = false
    }
) {
    suspend fun sync(
        url: String,
        anonKey: String,
        session: SupabaseSession,
        startDate: LocalDate = LocalDate.now().minusDays(29),
        endDate: LocalDate = LocalDate.now()
    ): SyncOutcome {
        val activeSession = if (
            session.expiresAtEpochSeconds > 0L &&
            session.expiresAtEpochSeconds <= Instant.now().epochSecond + 60L
        ) {
            supabaseSyncClient.refreshSession(url, anonKey, session).also {
                supabaseSessionStore.saveSession(it)
            }
        } else {
            session
        }
        val snapshot = repository.readSnapshot(startDate, endDate)
        val export = HealthConnectNormalizer.toExport(snapshot)
        supabaseSyncClient.uploadExport(url, anonKey, activeSession, export)
        supabaseSessionStore.saveSuccessfulSync(export.exportedAt)
        return SyncOutcome(export, json.encodeToString(export), activeSession)
    }
}
