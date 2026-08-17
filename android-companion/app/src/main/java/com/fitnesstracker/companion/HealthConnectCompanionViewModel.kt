package com.fitnesstracker.companion

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class CompanionUiState(
    val sdkStatus: HealthConnectSdkStatus = HealthConnectSdkStatus.UNAVAILABLE,
    val sdkMessage: String = "Checking Health Connect availability…",
    val requiredPermissions: Set<String> = emptySet(),
    val grantedPermissions: Set<String> = emptySet(),
    val startDate: String = LocalDate.now().minusDays(29).toString(),
    val endDate: String = LocalDate.now().toString(),
    val isBusy: Boolean = false,
    val errorMessage: String? = null,
    val infoMessage: String? = null,
    val exportPreview: String = "",
    val exportRecordCounts: HealthConnectRecordCounts = HealthConnectRecordCounts(),
    val trackerEntryCount: Int = 0,
    val dailySummaries: List<HealthConnectDailySummary> = emptyList(),
    val supabaseUrl: String = "",
    val supabaseAnonKey: String = "",
    val supabaseEmail: String = "",
    val supabaseOtp: String = "",
    val supabaseOtpRequested: Boolean = false,
    val supabaseSignedInEmail: String? = null,
    val supabaseMessage: String? = null,
    val supabaseErrorMessage: String? = null
) {
    val missingPermissions: Set<String>
        get() = requiredPermissions - grantedPermissions
}

class HealthConnectCompanionViewModel(
    private val repository: HealthConnectRepository,
    private val exportWriter: ExportWriter,
    private val supabaseSyncClient: SupabaseSyncClient = SupabaseSyncClient(),
    private val supabaseSessionStore: SupabaseSessionStore
) : ViewModel() {
    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val savedSupabaseState = supabaseSessionStore.load()

    var uiState by mutableStateOf(
        CompanionUiState(
            requiredPermissions = repository.requiredPermissions(),
            supabaseUrl = savedSupabaseState.url,
            supabaseAnonKey = savedSupabaseState.anonKey,
            supabaseEmail = savedSupabaseState.email,
            supabaseSignedInEmail = savedSupabaseState.session?.email
        )
    )
        private set

    private var currentExport: HealthConnectExport? = null
    private var supabaseSession: SupabaseSession? = savedSupabaseState.session

    init {
        refreshStatus()
    }

    fun refreshStatus() {
        viewModelScope.launch {
            val sdkStatus = repository.sdkStatus()
            val granted = if (sdkStatus == HealthConnectSdkStatus.AVAILABLE) {
                withContext(Dispatchers.IO) { repository.getGrantedPermissions() }
            } else {
                emptySet()
            }

            uiState = uiState.copy(
                sdkStatus = sdkStatus,
                sdkMessage = when (sdkStatus) {
                    HealthConnectSdkStatus.AVAILABLE -> "Health Connect is available."
                    HealthConnectSdkStatus.UPDATE_REQUIRED -> "Health Connect needs to be installed or updated on the device."
                    HealthConnectSdkStatus.UNAVAILABLE -> "Health Connect is unavailable on this device."
                },
                grantedPermissions = granted,
                errorMessage = null,
                infoMessage = if (sdkStatus == HealthConnectSdkStatus.AVAILABLE && granted.isNotEmpty()) {
                    "Ready to read ${granted.size} granted permissions."
                } else {
                    uiState.infoMessage
                }
            )
        }
    }

    fun updateStartDate(value: String) {
        uiState = uiState.copy(startDate = value, errorMessage = null, infoMessage = null)
    }

    fun updateEndDate(value: String) {
        uiState = uiState.copy(endDate = value, errorMessage = null, infoMessage = null)
    }

    fun selectQuickRange(days: Long) {
        val end = LocalDate.now()
        val start = end.minusDays(days - 1)
        uiState = uiState.copy(
            startDate = start.toString(),
            endDate = end.toString(),
            errorMessage = null,
            infoMessage = null
        )
    }

    fun updateSupabaseUrl(value: String) {
        supabaseSession = null
        supabaseSessionStore.clearSession()
        supabaseSessionStore.saveConfiguration(value.trim(), uiState.supabaseAnonKey.trim(), uiState.supabaseEmail.trim())
        uiState = uiState.copy(
            supabaseUrl = value,
            supabaseSignedInEmail = null,
            supabaseOtpRequested = false,
            supabaseMessage = null,
            supabaseErrorMessage = null
        )
    }

    fun updateSupabaseAnonKey(value: String) {
        supabaseSession = null
        supabaseSessionStore.clearSession()
        supabaseSessionStore.saveConfiguration(uiState.supabaseUrl.trim(), value.trim(), uiState.supabaseEmail.trim())
        uiState = uiState.copy(
            supabaseAnonKey = value,
            supabaseSignedInEmail = null,
            supabaseOtpRequested = false,
            supabaseMessage = null,
            supabaseErrorMessage = null
        )
    }

    fun updateSupabaseEmail(value: String) {
        supabaseSession = null
        supabaseSessionStore.clearSession()
        supabaseSessionStore.saveConfiguration(uiState.supabaseUrl.trim(), uiState.supabaseAnonKey.trim(), value.trim())
        uiState = uiState.copy(
            supabaseEmail = value,
            supabaseSignedInEmail = null,
            supabaseOtpRequested = false,
            supabaseMessage = null,
            supabaseErrorMessage = null
        )
    }

    fun updateSupabaseOtp(value: String) {
        uiState = uiState.copy(
            supabaseOtp = value,
            supabaseErrorMessage = null
        )
    }

    fun requestSupabaseOtp() {
        val url = uiState.supabaseUrl.trim()
        val anonKey = uiState.supabaseAnonKey.trim()
        val email = uiState.supabaseEmail.trim()
        val validationError = validateSupabaseConfig(url, anonKey, email)
        if (validationError != null) {
            uiState = uiState.copy(supabaseErrorMessage = validationError, supabaseMessage = null)
            return
        }

        viewModelScope.launch {
            uiState = uiState.copy(
                isBusy = true,
                supabaseMessage = null,
                supabaseErrorMessage = null
            )
            runCatching {
                withContext(Dispatchers.IO) {
                    supabaseSyncClient.requestEmailOtp(url, anonKey, email)
                }
            }.onSuccess {
                uiState = uiState.copy(
                    isBusy = false,
                    supabaseOtpRequested = true,
                    supabaseMessage = "OTP sent to $email. Check your email and enter the code.",
                    supabaseErrorMessage = null
                )
            }.onFailure { error ->
                uiState = uiState.copy(
                    isBusy = false,
                    supabaseErrorMessage = error.message ?: "Unable to request a Supabase OTP.",
                    supabaseMessage = null
                )
            }
        }
    }

    fun verifySupabaseOtp() {
        val url = uiState.supabaseUrl.trim()
        val anonKey = uiState.supabaseAnonKey.trim()
        val email = uiState.supabaseEmail.trim()
        val otp = uiState.supabaseOtp.trim()
        val validationError = validateSupabaseConfig(url, anonKey, email)
            ?: if (otp.isBlank()) "Enter the OTP from your email." else null
        if (validationError != null) {
            uiState = uiState.copy(supabaseErrorMessage = validationError, supabaseMessage = null)
            return
        }

        viewModelScope.launch {
            uiState = uiState.copy(
                isBusy = true,
                supabaseMessage = null,
                supabaseErrorMessage = null
            )
            runCatching {
                withContext(Dispatchers.IO) {
                    supabaseSyncClient.verifyEmailOtp(url, anonKey, email, otp)
                }
            }.onSuccess { session ->
                supabaseSession = session
                supabaseSessionStore.saveSession(session)
                uiState = uiState.copy(
                    isBusy = false,
                    supabaseOtpRequested = false,
                    supabaseSignedInEmail = session.email ?: email,
                    supabaseMessage = "Supabase sign-in verified. You can sync to the tracker.",
                    supabaseErrorMessage = null
                )
            }.onFailure { error ->
                uiState = uiState.copy(
                    isBusy = false,
                    supabaseErrorMessage = error.message ?: "Unable to verify the Supabase OTP.",
                    supabaseMessage = null
                )
            }
        }
    }

    fun syncToTracker() {
        val session = supabaseSession
        if (session == null) {
            uiState = uiState.copy(
                supabaseErrorMessage = "Verify the Supabase OTP before syncing.",
                supabaseMessage = null
            )
            return
        }
        val url = uiState.supabaseUrl.trim()
        val anonKey = uiState.supabaseAnonKey.trim()
        val validationError = validateSupabaseConfig(
            url,
            anonKey,
            uiState.supabaseEmail.trim()
        )
        if (validationError != null) {
            uiState = uiState.copy(supabaseErrorMessage = validationError, supabaseMessage = null)
            return
        }

        viewModelScope.launch {
            uiState = uiState.copy(
                isBusy = true,
                supabaseMessage = null,
                supabaseErrorMessage = null,
                errorMessage = null,
                infoMessage = null
            )
            runCatching {
                val (export, preview) = buildExport()
                val activeSession = withContext(Dispatchers.IO) {
                    if (session.expiresAtEpochSeconds > 0L &&
                        session.expiresAtEpochSeconds <= java.time.Instant.now().epochSecond + 60L
                    ) {
                        supabaseSyncClient.refreshSession(url, anonKey, session)
                    } else {
                        session
                    }
                }
                if (activeSession !== session) {
                    supabaseSession = activeSession
                    supabaseSessionStore.saveSession(activeSession)
                }
                withContext(Dispatchers.IO) {
                    supabaseSyncClient.uploadExport(url, anonKey, activeSession, export)
                }
                Triple(export, preview, activeSession)
            }.onSuccess { (export, preview, signedInSession) ->
                currentExport = export
                uiState = uiState.copy(
                    isBusy = false,
                    exportPreview = preview,
                    exportRecordCounts = export.recordCounts,
                    trackerEntryCount = export.trackerPayloadPatch.entries.size,
                    dailySummaries = export.dailySummaries,
                    supabaseMessage = "Synced ${export.trackerPayloadPatch.entries.size} tracker entries to Supabase for ${signedInSession.email ?: "this user"}.",
                    supabaseErrorMessage = null
                )
            }.onFailure { error ->
                uiState = uiState.copy(
                    isBusy = false,
                    supabaseErrorMessage = error.message ?: "Unable to sync to the tracker.",
                    supabaseMessage = null
                )
            }
        }
    }

    fun onPermissionsResult(grantedPermissions: Set<String>) {
        uiState = uiState.copy(
            grantedPermissions = grantedPermissions,
            infoMessage = if (grantedPermissions.isEmpty()) {
                "No Health Connect permissions were granted."
            } else {
                "Granted ${grantedPermissions.size} Health Connect permissions."
            },
            errorMessage = null
        )
        refreshStatus()
    }

    fun buildExportPreview() {
        viewModelScope.launch {
            uiState = uiState.copy(isBusy = true, errorMessage = null, infoMessage = null)
            runCatching {
                buildExport()
            }.onSuccess { (export, preview) ->
                currentExport = export
                uiState = uiState.copy(
                    isBusy = false,
                    exportPreview = preview,
                    exportRecordCounts = export.recordCounts,
                    trackerEntryCount = export.trackerPayloadPatch.entries.size,
                    dailySummaries = export.dailySummaries,
                    infoMessage = "Export preview ready.",
                    errorMessage = null
                )
            }.onFailure { error ->
                currentExport = null
                uiState = uiState.copy(
                    isBusy = false,
                    errorMessage = error.message ?: "Unable to build Health Connect export.",
                    infoMessage = null
                )
            }
        }
    }

    private suspend fun buildExport(): Pair<HealthConnectExport, String> {
        val startDate = LocalDate.parse(uiState.startDate.trim())
        val endDate = LocalDate.parse(uiState.endDate.trim())
        val snapshot = withContext(Dispatchers.IO) {
            repository.readSnapshot(startDate, endDate)
        }
        val export = HealthConnectNormalizer.toExport(snapshot)
        return export to json.encodeToString(export)
    }

    fun exportFileName(): String {
        return "fitness-tracker-health-connect-${uiState.startDate}-${uiState.endDate}.json"
    }

    fun saveExport(uri: Uri) {
        viewModelScope.launch {
            val export = currentExport
            if (export == null) {
                uiState = uiState.copy(errorMessage = "Generate an export preview before saving.")
                return@launch
            }

            uiState = uiState.copy(isBusy = true, errorMessage = null, infoMessage = null)
            runCatching {
                withContext(Dispatchers.IO) {
                    exportWriter.writeJson(uri, json.encodeToString(export))
                }
            }.onSuccess {
                uiState = uiState.copy(
                    isBusy = false,
                    infoMessage = "JSON export saved.",
                    errorMessage = null
                )
            }.onFailure { error ->
                uiState = uiState.copy(
                    isBusy = false,
                    errorMessage = error.message ?: "Unable to save JSON export.",
                    infoMessage = null
                )
            }
        }
    }

    class Factory(private val appContext: Context) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
            return HealthConnectCompanionViewModel(
                repository = HealthConnectRepository(appContext),
                exportWriter = ExportWriter(appContext),
                supabaseSyncClient = SupabaseSyncClient(),
                supabaseSessionStore = SupabaseSessionStore(appContext)
            ) as T
        }
    }

    private fun validateSupabaseConfig(
        url: String,
        anonKey: String,
        email: String
    ): String? {
        return when {
            url.isBlank() -> "Enter your Supabase project URL."
            !url.startsWith("https://") -> "Supabase URL must start with https://."
            anonKey.isBlank() -> "Enter your Supabase anon key."
            email.isBlank() -> "Enter the email used for Supabase OTP sign-in."
            !email.contains("@") -> "Enter a valid email address."
            else -> null
        }
    }
}
