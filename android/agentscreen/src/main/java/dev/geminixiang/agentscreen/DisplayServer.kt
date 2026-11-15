package dev.geminixiang.agentscreen

import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Looper
import android.util.Base64
import java.io.ByteArrayOutputStream

object DisplayServer {
    private const val SHELL = "com.android.shell"
    private const val SHELL_UID = 2000
    private const val FLAGS = 1 or 8 or 64 or 128 or 256 or 8192 or 1024 or 2048 or 4096 or 16384 or 65536

    @JvmStatic
    fun main(args: Array<String>) {
        val width = args.getOrNull(0)?.toIntOrNull() ?: 1080
        val height = args.getOrNull(1)?.toIntOrNull() ?: 2340
        val dpi = args.getOrNull(2)?.toIntOrNull() ?: 420
        Looper.prepareMainLooper()
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        val display = displayManager().createVirtualDisplay("pi-agent", width, height, dpi, reader.surface, FLAGS)
        println("display ${display.display.displayId}")
        serve(reader, width)
        display.release()
    }

    private fun serve(reader: ImageReader, width: Int) {
        generateSequence { readlnOrNull() }.forEach { line ->
            if (line.trim() == "shot") println("shot ${shot(reader, width)}")
        }
    }

    private fun shot(reader: ImageReader, width: Int): String {
        val image = reader.acquireLatestImage() ?: return ""
        val plane = image.planes[0]
        val stride = plane.rowStride / plane.pixelStride
        val bitmap = Bitmap.createBitmap(stride, image.height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(plane.buffer)
        image.close()
        val cropped = Bitmap.createBitmap(bitmap, 0, 0, width, bitmap.height)
        val bytes = ByteArrayOutputStream()
        cropped.compress(Bitmap.CompressFormat.JPEG, 80, bytes)
        return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
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
