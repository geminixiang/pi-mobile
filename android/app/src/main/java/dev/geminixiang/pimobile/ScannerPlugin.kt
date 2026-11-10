package dev.geminixiang.pimobile

import android.app.Activity
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

@CapacitorPlugin(name = "Scanner")
class ScannerPlugin : Plugin() {
    private lateinit var launcher: ActivityResultLauncher<IntentSenderRequest>
    private var pending: PluginCall? = null
    private val recognizer by lazy { TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) }

    override fun load() {
        launcher =
            activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
                val call = pending ?: return@registerForActivityResult
                pending = null
                if (result.resultCode != Activity.RESULT_OK) {
                    call.resolve(JSObject().put("cancelled", true))
                    return@registerForActivityResult
                }
                val pdf = GmsDocumentScanningResult.fromActivityResultIntent(result.data)?.pdf
                if (pdf == null) {
                    call.reject("the scanner returned nothing")
                    return@registerForActivityResult
                }
                try {
                    val file = copy(pdf.uri, ".pdf")
                    call.resolve(JSObject().put("cancelled", false).put("pdf", file.absolutePath).put("pages", pdf.pageCount))
                } catch (error: IOException) {
                    call.reject("could not keep the scan", error)
                }
            }
    }

    private fun copy(uri: Uri, suffix: String): File {
        val target = File(emptyScansFolder(), "${UUID.randomUUID()}$suffix")
        val input = context.contentResolver.openInputStream(uri) ?: throw IOException("no data at $uri")
        input.use { source -> FileOutputStream(target).use { source.copyTo(it) } }
        return target
    }

    private fun emptyScansFolder(): File {
        val folder = File(context.filesDir, "scans")
        folder.listFiles()?.forEach { if (!it.delete()) Log.w("PiScanner", "could not delete $it") }
        if (!folder.isDirectory && !folder.mkdirs()) throw IOException("could not create $folder")
        return folder
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        if (!TriggersPlugin.inFront(activity)) {
            call.reject("pi is in the background; the scanner needs the user. Ask them to open pi.")
            return
        }
        val options =
            GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(true)
                .setPageLimit(call.getInt("pages", 20) ?: 20)
                .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .build()
        GmsDocumentScanning.getClient(options)
            .getStartScanIntent(activity)
            .addOnSuccessListener { sender ->
                pending = call
                launcher.launch(IntentSenderRequest.Builder(sender).build())
            }
            .addOnFailureListener { error -> call.reject("the scanner is not available: ${error.message}") }
    }

    @PluginMethod
    fun ocr(call: PluginCall) {
        val bytes = Base64.decode(call.getString("data", "").orEmpty(), Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bitmap == null) {
            call.reject("not an image")
            return
        }
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { text -> call.resolve(JSObject().put("text", text.text)) }
            .addOnFailureListener { error -> call.reject("could not read the image: ${error.message}") }
    }
}
