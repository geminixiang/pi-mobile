package dev.geminixiang.pimobile

import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import android.util.Log
import android.view.View
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

class AssistSession internal constructor(context: Context) : VoiceInteractionSession(context) {
    private val main = Handler(Looper.getMainLooper())
    private var screenText: String? = null
    private var appName: String? = null
    private var screenshot: Bitmap? = null
    private var structureDone = false
    private var screenshotDone = false
    private var sent = false

    override fun onShow(args: Bundle?, flags: Int) {
        super.onShow(args, flags)
        main.postDelayed(::send, WAIT_MS)
    }

    override fun onHandleAssist(state: AssistState) {
        state.assistStructure?.let { structure ->
            structure.activityComponent?.let { appName = NotificationsListener.appLabel(context.packageManager, it.packageName) }
            val lines = LinkedHashSet<String>()
            for (i in 0 until structure.windowNodeCount) collect(structure.getWindowNodeAt(i).rootViewNode, lines)
            screenText = lines.joinToString("\n")
        }
        structureDone = true
        if (screenshotDone) main.post(::send)
    }

    override fun onHandleScreenshot(bitmap: Bitmap?) {
        screenshot = bitmap
        screenshotDone = true
        if (structureDone) main.post(::send)
    }

    private fun send() {
        if (sent) return
        sent = true
        val event = JSObject()
        try {
            event.put("kind", "share")
            event.put("source", "assist")
            appName?.let { event.put("subject", it) }
            val files = JSArray()
            screenshot?.let { bitmap ->
                val image = File(TriggerStore.inbox(context), "${UUID.randomUUID()}.jpg")
                FileOutputStream(image).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                files.put(JSObject().put("path", image.absolutePath).put("name", "畫面.jpg").put("mimeType", "image/jpeg"))
            }
            val text = screenText
            if (!text.isNullOrEmpty()) {
                val file = File(TriggerStore.inbox(context), "${UUID.randomUUID()}.txt")
                file.writeText(text, Charsets.UTF_8)
                files.put(JSObject().put("path", file.absolutePath).put("name", "${appName ?: "畫面"} 的文字.txt").put("mimeType", "text/plain"))
            }
            if (files.length() > 0) event.put("files", files)
        } catch (error: IOException) {
            Log.w(TAG, "could not keep the screen", error)
        }
        TriggerStore.enqueue(context, event)
        TriggersPlugin.live()?.announce()
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    companion object {
        private const val TAG = "PiAssist"
        private const val WAIT_MS = 1500L

        private fun collect(node: AssistStructure.ViewNode?, lines: MutableSet<String>) {
            if (node == null || node.visibility != View.VISIBLE) return
            val text = node.text?.toString()?.trim().orEmpty()
            val description = node.contentDescription?.toString()?.trim().orEmpty()
            if (text.isNotEmpty()) {
                lines.add(text)
            } else if (description.isNotEmpty()) {
                lines.add(description)
            }
            for (i in 0 until node.childCount) collect(node.getChildAt(i), lines)
        }
    }
}
