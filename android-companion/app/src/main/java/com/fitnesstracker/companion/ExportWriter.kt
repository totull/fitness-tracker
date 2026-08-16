package com.fitnesstracker.companion

import android.content.Context
import android.net.Uri

class ExportWriter(private val context: Context) {
    fun writeJson(uri: Uri, payload: String) {
        val resolver = context.contentResolver
        val stream = resolver.openOutputStream(uri)
            ?: error("Unable to open export destination.")
        stream.bufferedWriter().use { writer ->
            writer.write(payload)
        }
    }
}

