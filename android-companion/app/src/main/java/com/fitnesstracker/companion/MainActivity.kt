package com.fitnesstracker.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<HealthConnectCompanionViewModel> {
        HealthConnectCompanionViewModel.Factory(applicationContext)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    CompanionApp(viewModel = viewModel)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        viewModel.onAppForegrounded()
    }
}

@Composable
private fun CompanionApp(viewModel: HealthConnectCompanionViewModel) {
    val state = viewModel.uiState
    val permissionLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        viewModel.onPermissionsResult(granted)
    }
    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        if (uri != null) {
            viewModel.saveExport(uri)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer
            )
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Fitness Tracker Android Companion",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Reads Health Connect with user consent and exports a safe JSON patch for the existing web tracker.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Out of scope by design: Garmin credentials, Bluetooth pairing, unofficial Garmin APIs.",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        StatusCard(state = state)

        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    "Supabase sync",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    "Sign in with an email OTP, then upload the current Health Connect export directly to the tracker.",
                    style = MaterialTheme.typography.bodyMedium
                )
                OutlinedTextField(
                    value = state.supabaseUrl,
                    onValueChange = viewModel::updateSupabaseUrl,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Supabase URL") },
                    placeholder = { Text("https://your-project.supabase.co") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri)
                )
                OutlinedTextField(
                    value = state.supabaseAnonKey,
                    onValueChange = viewModel::updateSupabaseAnonKey,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Supabase anon key") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii)
                )
                OutlinedTextField(
                    value = state.supabaseEmail,
                    onValueChange = viewModel::updateSupabaseEmail,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email)
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = viewModel::requestSupabaseOtp,
                        enabled = !state.isBusy
                    ) {
                        Text("Request OTP")
                    }
                    if (state.supabaseSignedInEmail == null) {
                        OutlinedButton(
                            onClick = viewModel::verifySupabaseOtp,
                            enabled = state.supabaseOtpRequested && !state.isBusy
                        ) {
                            Text("Verify OTP")
                        }
                    }
                }
                if (state.supabaseOtpRequested && state.supabaseSignedInEmail == null) {
                    OutlinedTextField(
                        value = state.supabaseOtp,
                        onValueChange = viewModel::updateSupabaseOtp,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Email OTP") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                    )
                }
                Text(
                    text = state.supabaseSignedInEmail?.let {
                        "Signed in as $it"
                    } ?: "Not signed in.",
                    style = MaterialTheme.typography.bodySmall
                )
                Text(
                    text = state.lastSuccessfulSyncAt?.let {
                        "Last successful background sync: $it"
                    } ?: "No successful background sync yet.",
                    style = MaterialTheme.typography.bodySmall
                )
                state.lastSyncError?.let {
                    Text(
                        text = "Last sync error: $it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                Text(
                    "Background sync runs about every 4 hours when network and Health Connect background access are available. On OnePlus/OxygenOS, set this app to Settings → Battery → App battery usage → Unrestricted.",
                    style = MaterialTheme.typography.bodySmall
                )
                Button(
                    onClick = viewModel::syncToTracker,
                    enabled = state.supabaseSignedInEmail != null && !state.isBusy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Sync to tracker")
                }
                if (state.isBusy) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.width(20.dp))
                        Text("Contacting Supabase…", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                state.supabaseErrorMessage?.let {
                    MessageBlock(
                        text = it,
                        background = MaterialTheme.colorScheme.errorContainer
                    )
                }
                state.supabaseMessage?.let {
                    MessageBlock(
                        text = it,
                        background = MaterialTheme.colorScheme.secondaryContainer
                    )
                }
            }
        }

        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("Permissions", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    text = if (state.missingPermissions.isEmpty() && state.grantedPermissions.isNotEmpty()) {
                        "All required read permissions are granted."
                    } else {
                        "Grant the Health Connect read permissions needed for export."
                    },
                    style = MaterialTheme.typography.bodyMedium
                )
                if (HealthConnectRepository.BACKGROUND_PERMISSION !in state.grantedPermissions) {
                    Text(
                        "Background sync also requires Health Connect background read access.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                state.requiredPermissions.forEach { permission ->
                    Text(
                        text = "• ${permissionLabel(permission)} ${if (permission in state.grantedPermissions) "✓" else ""}",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Button(
                    onClick = {
                        permissionLauncher.launch(
                            if (state.missingPermissions.isEmpty()) {
                                state.requiredPermissions
                            } else {
                                state.missingPermissions
                            }
                        )
                    },
                    enabled = state.sdkStatus == HealthConnectSdkStatus.AVAILABLE && !state.isBusy
                ) {
                    Text("Grant / review permissions")
                }
            }
        }

        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("Date range", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { viewModel.selectQuickRange(7) }, enabled = !state.isBusy) {
                        Text("7 days")
                    }
                    OutlinedButton(onClick = { viewModel.selectQuickRange(30) }, enabled = !state.isBusy) {
                        Text("30 days")
                    }
                    OutlinedButton(onClick = { viewModel.selectQuickRange(90) }, enabled = !state.isBusy) {
                        Text("90 days")
                    }
                }
                OutlinedTextField(
                    value = state.startDate,
                    onValueChange = viewModel::updateStartDate,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Start date (YYYY-MM-DD)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii)
                )
                OutlinedTextField(
                    value = state.endDate,
                    onValueChange = viewModel::updateEndDate,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("End date (YYYY-MM-DD)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii)
                )
            }
        }

        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("Export", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = viewModel::buildExportPreview,
                        enabled = state.sdkStatus == HealthConnectSdkStatus.AVAILABLE && !state.isBusy
                    ) {
                        Text("Refresh preview")
                    }
                    OutlinedButton(
                        onClick = { exportLauncher.launch(viewModel.exportFileName()) },
                        enabled = state.exportPreview.isNotBlank() && !state.isBusy
                    ) {
                        Text("Save JSON")
                    }
                }

                if (state.isBusy) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.width(20.dp))
                        Text("Working…", style = MaterialTheme.typography.bodyMedium)
                    }
                }

                state.errorMessage?.let {
                    MessageBlock(
                        text = it,
                        background = MaterialTheme.colorScheme.errorContainer
                    )
                }

                state.infoMessage?.let {
                    MessageBlock(
                        text = it,
                        background = MaterialTheme.colorScheme.secondaryContainer
                    )
                }

                if (state.exportPreview.isNotBlank()) {
                    Text(
                        text = "Tracker entries: ${state.trackerEntryCount} • Raw records read: ${state.exportRecordCounts.total()}",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                color = Color(0xFFF5F5F5),
                                shape = MaterialTheme.shapes.medium
                            )
                            .padding(12.dp)
                    ) {
                        Text(
                            text = state.exportPreview,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }
            }
        }

        if (state.dailySummaries.isNotEmpty()) {
            Card {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text("Daily summaries", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    state.dailySummaries.takeLast(14).reversed().forEach { day ->
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(day.date, fontWeight = FontWeight.SemiBold)
                            Text(
                                text = buildString {
                                    append("Steps ${day.steps}")
                                    if (day.latestWeightKg != null) append(" • Weight ${day.latestWeightKg}")
                                    if (day.sleepHours > 0) append(" • Sleep ${day.sleepHours}")
                                    if (day.exerciseMinutes > 0) append(" • Exercise ${day.exerciseMinutes}m")
                                },
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusCard(state: CompanionUiState) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text("Health Connect status", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(state.sdkMessage, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = "Granted ${state.grantedPermissions.size} of ${state.requiredPermissions.size} permissions.",
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun MessageBlock(text: String, background: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(background, shape = MaterialTheme.shapes.medium)
            .padding(12.dp)
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall)
    }
}

private fun permissionLabel(permission: String): String {
    return permission
        .substringAfterLast('.')
        .removePrefix("READ_")
        .lowercase()
        .split('_')
        .joinToString(" ") { token ->
            token.replaceFirstChar { char -> char.uppercase() }
        }
}
