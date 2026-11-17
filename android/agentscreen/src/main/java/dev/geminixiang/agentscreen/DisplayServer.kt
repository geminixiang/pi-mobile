package dev.geminixiang.agentscreen

import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import java.io.DataOutputStream
import java.util.concurrent.CountDownLatch

object DisplayServer {
    private const val SHELL = "com.android.shell"
    private const val SHELL_UID = 2000
    private const val PUBLIC = 1
    private const val OWN_CONTENT_ONLY = 8
    private const val SUPPORTS_TOUCH = 64
    private const val ROTATES_WITH_CONTENT = 128
    private const val DESTROY_CONTENT_ON_REMOVAL = 256
    private const val TRUSTED = 1024
    private const val OWN_DISPLAY_GROUP = 2048
    private const val ALWAYS_UNLOCKED = 4096
    private const val TOUCH_FEEDBACK_DISABLED = 8192
    private const val OWN_FOCUS = 16384
    private const val STEAL_TOP_FOCUS_DISABLED = 65536
    private const val FLAGS = PUBLIC or OWN_CONTENT_ONLY or SUPPORTS_TOUCH or ROTATES_WITH_CONTENT or DESTROY_CONTENT_ON_REMOVAL or TRUSTED or
        OWN_DISPLAY_GROUP or ALWAYS_UNLOCKED or TOUCH_FEEDBACK_DISABLED or OWN_FOCUS or STEAL_TOP_FOCUS_DISABLED

    @JvmStatic
    fun main(args: Array<String>) {
        val width = args.getOrNull(0)?.toIntOrNull() ?: 1080
        val height = args.getOrNull(1)?.toIntOrNull() ?: 2340
        val dpi = args.getOrNull(2)?.toIntOrNull() ?: 420
        Looper.prepareMainLooper()
        val frames = HandlerThread("frames").apply { start() }
        val reader = ImageReader.newInstance(videoSize(width), videoSize(height), PixelFormat.RGBA_8888, 2)
        reader.setOnImageAvailableListener({ it.acquireLatestImage()?.close() }, Handler(frames.looper))
        val display = displayManager().createVirtualDisplay("pi-agent", videoSize(width), videoSize(height), dpi * videoSize(width) / width, reader.surface, FLAGS)
        println("display ${display.display.displayId}")
        val output = DataOutputStream(System.out)
        val handler = Handler(frames.looper)
        var encoder: VideoEncoder? = null
        try {
            generateSequence(::readlnOrNull).forEach { command ->
                val parts = command.split(' ')
                if (parts.take(2) == listOf("watch", "on")) {
                    val generation = parts.getOrNull(2)?.toIntOrNull() ?: return@forEach
                    handler.post {
                        display.surface = reader.surface
                        encoder?.close()
                        encoder = null
                        runCatching { VideoEncoder(width, height, generation, handler, output) }.fold(
                            { encoder = it; display.surface = it.surface },
                            { packet(output, generation, 0, -1, (it.message ?: "encoder_failed").toByteArray()) },
                        )
                    }
                }
                if (command == "watch off") handler.post {
                    display.surface = reader.surface
                    encoder?.close()
                    encoder = null
                }
            }
        } finally {
            val released = CountDownLatch(1)
            handler.post {
                try {
                    display.release()
                    encoder?.close()
                    reader.close()
                } finally {
                    frames.quitSafely()
                    released.countDown()
                }
            }
            released.await()
        }
    }

    private fun displayManager(): DisplayManager {
        val threadClass = Class.forName("android.app.ActivityThread")
        val thread = threadClass.getDeclaredConstructor().newInstance()
        threadClass.getDeclaredField("sCurrentActivityThread").apply { isAccessible = true }.set(null, thread)
        threadClass.getDeclaredField("mSystemThread").apply { isAccessible = true }.setBoolean(thread, true)
        val controllerClass = Class.forName("android.app.ConfigurationController")
        val controller = controllerClass.getDeclaredConstructor(Class.forName("android.app.ActivityThreadInternal")).apply { isAccessible = true }.newInstance(thread)
        threadClass.getDeclaredField("mConfigurationController").apply { isAccessible = true }.set(thread, controller)
        val system = threadClass.getDeclaredMethod("getSystemContext").apply { isAccessible = true }.invoke(thread)
        val context = ShellContext(system as Context)
        return DisplayManager::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }.newInstance(context)
    }

    private class ShellContext(base: Context) : ContextWrapper(base) {
        override fun getPackageName() = SHELL
        override fun getOpPackageName() = SHELL
        override fun getAttributionSource(): AttributionSource = AttributionSource.Builder(SHELL_UID).setPackageName(SHELL).build()
        override fun getApplicationContext() = this
    }
}
