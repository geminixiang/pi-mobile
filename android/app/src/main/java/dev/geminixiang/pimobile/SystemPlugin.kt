package dev.geminixiang.pimobile

import android.app.role.RoleManager
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.geminixiang.pimobile.Background.Failure
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.HexFormat

private const val UPDATE_READ_MS = 60_000

@CapacitorPlugin(name = "System")
class SystemPlugin : Plugin() {
    @PluginMethod
    fun openExternal(call: PluginCall) {
        val url = call.getString("url")
        val loopback = url != null && (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:"))
        if (url == null || !(url.startsWith("https://") || loopback)) {
            call.reject("https URL required")
            return
        }
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun haptic(call: PluginCall) {
        val constant =
            when (call.getString("kind", "tick")) {
                "press" -> HapticFeedbackConstants.LONG_PRESS
                "confirm" -> HapticFeedbackConstants.CONFIRM
                else -> HapticFeedbackConstants.SEGMENT_TICK
            }
        activity.runOnUiThread { bridge.webView.performHapticFeedback(constant) }
        call.resolve()
    }

    @PluginMethod
    fun appendLog(call: PluginCall) {
        val lines = call.getArray("lines").toList<String>()
        DeviceLog.append(context, lines)
        call.resolve()
    }

    @PluginMethod
    fun readLog(call: PluginCall) {
        DeviceLog.read(context) { text -> call.resolve(JSObject().put("text", text)) }
    }

    @PluginMethod
    fun network(call: PluginCall) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val online =
            connectivity.allNetworks.any { network ->
                val capabilities = connectivity.getNetworkCapabilities(network)
                capabilities != null &&
                    !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            }
        call.resolve(JSObject().put("online", online))
    }

    @PluginMethod
    fun clipboardText(call: PluginCall) {
        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
        val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context) else null
        call.resolve(JSObject().put("text", text?.toString().orEmpty()))
    }

    @PluginMethod
    fun assistant(call: PluginCall) {
        val roles = context.getSystemService(RoleManager::class.java)
        call.resolve(JSObject().put("held", roles != null && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)))
    }

    @PluginMethod
    fun openAssistantSettings(call: PluginCall) {
        openSettings(context, Intent(Settings.ACTION_VOICE_INPUT_SETTINGS), Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
        call.resolve()
    }

    @PluginMethod
    fun installUpdate(call: PluginCall) {
        val url = call.getString("url", "").orEmpty()
        val sha256 = call.getString("sha256", "").orEmpty()
        if (!url.startsWith("https://")) {
            call.reject("https URL required")
            return
        }
        val context = context
        Background.run(call) {
            val apk = File(File(context.cacheDir, "update"), "pi-mobile.apk")
            download(url, apk, sha256)
            requireSameApp(context, apk)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
            val install =
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            val installer = context.packageManager.queryIntentActivities(install, PackageManager.MATCH_SYSTEM_ONLY)[0].activityInfo.packageName
            context.startActivity(install.setPackage(installer))
            call.resolve()
        }
    }

    companion object {
        @JvmStatic
        fun openSettings(context: Context, preferred: Intent, fallbackAction: String) {
            try {
                context.startActivity(preferred.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (unavailable: RuntimeException) {
                context.startActivity(Intent(fallbackAction).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }

        private fun download(url: String, apk: File, sha256: String) {
            val folder = apk.parentFile ?: throw IOException("no folder for ${apk.name}")
            if (!folder.isDirectory && !folder.mkdirs()) throw IOException("cannot create ${folder.name}")
            val digest = MessageDigest.getInstance("SHA-256")
            val fetched = Http.get(URL(url), UPDATE_READ_MS)
            try {
                if (fetched.status != HttpURLConnection.HTTP_OK) throw Failure("download", "HTTP ${fetched.status}")
                DigestInputStream(fetched.connection.inputStream, digest).use { input -> apk.outputStream().use { input.transferTo(it) } }
            } finally {
                fetched.connection.disconnect()
            }
            if (HexFormat.of().formatHex(digest.digest()) != sha256) throw Failure("checksum", "the download does not match its SHA-256")
        }

        private fun requireSameApp(context: Context, apk: File) {
            val packages = context.packageManager
            val archive = packages.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            if (archive == null || context.packageName != archive.packageName) throw Failure("not_this_app", "the download is not pi mobile")
            val installed = packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val signers = archive.signingInfo?.apkContentsSigners
            if (signers == null || !signers.contentEquals(installed.signingInfo?.apkContentsSigners)) throw Failure("other_key", "the download is signed with another key")
        }
    }
}
