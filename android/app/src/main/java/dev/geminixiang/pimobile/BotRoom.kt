package dev.geminixiang.pimobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.Log
import java.io.IOException

private const val FLOOR = 0.72f
private const val MAX_BOT_DP = 60f

object BotRoom {
    fun draw(context: Context, avatars: List<String>, widthDp: Int, heightDp: Int): Bitmap {
        val density = context.resources.displayMetrics.density
        val width = (widthDp * density).toInt().coerceAtLeast(1)
        val height = (heightDp * density).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val ink = context.getColor(R.color.widget_muted)
        val text = context.getColor(R.color.widget_text)
        val fill = Paint().apply { color = ink }
        val floorY = height * FLOOR

        fill.alpha = 26
        canvas.drawRect(0f, floorY, width.toFloat(), height.toFloat(), fill)
        fill.alpha = 70
        canvas.drawRect(0f, floorY, width.toFloat(), floorY + 2 * density, fill)

        val window = RectF(width * 0.68f, height * 0.14f, width * 0.88f, height * 0.50f)
        fill.alpha = 30
        canvas.drawRect(window, fill)
        val frame = Paint().apply { color = ink; alpha = 90; style = Paint.Style.STROKE; strokeWidth = 2 * density }
        canvas.drawRect(window, frame)
        canvas.drawLine(window.centerX(), window.top, window.centerX(), window.bottom, frame)
        canvas.drawLine(window.left, window.centerY(), window.right, window.centerY(), frame)
        val moon = Paint().apply { color = text; alpha = 120; isAntiAlias = true }
        val moonRadius = window.width() * 0.12f
        canvas.drawCircle(window.right - window.width() * 0.25f, window.top + window.height() * 0.25f, moonRadius, moon)
        moon.alpha = 100
        val star = 1.5f * density
        canvas.drawRect(window.left + window.width() * 0.2f, window.top + window.height() * 0.18f, window.left + window.width() * 0.2f + star, window.top + window.height() * 0.18f + star, moon)
        canvas.drawRect(window.left + window.width() * 0.32f, window.top + window.height() * 0.68f, window.left + window.width() * 0.32f + star, window.top + window.height() * 0.68f + star, moon)
        canvas.drawRect(window.left + window.width() * 0.75f, window.top + window.height() * 0.72f, window.left + window.width() * 0.75f + star, window.top + window.height() * 0.72f + star, moon)

        val size = minOf(height * 0.40f, MAX_BOT_DP * density)
        val gap = size * 0.40f
        val start = width * 0.08f
        val room = window.left - start - width * 0.02f
        val fits = ((room + gap) / (size + gap)).toInt()
        val residents = avatars.take(fits)
        val pixels = Paint().apply { isFilterBitmap = false }
        val snore = Paint().apply { color = ink; alpha = 150; isAntiAlias = true; typeface = Typeface.DEFAULT_BOLD }
        val cushion = Paint().apply { color = ink; alpha = 45 }
        residents.forEachIndexed { index, avatar ->
            val sprite = sprite(context, avatar) ?: return@forEachIndexed
            val left = start + index * (size + gap)
            val dozing = index % 2 == 0
            val top = floorY - size * (if (dozing) 1.0f else 0.92f)
            if (dozing) canvas.drawRect(left - size * 0.08f, floorY - size * 0.10f, left + size * 1.08f, floorY + size * 0.06f, cushion)
            canvas.save()
            if (dozing) canvas.rotate(-10f, left + size / 2, floorY)
            canvas.drawBitmap(sprite, null, RectF(left, top, left + size, top + size), pixels)
            canvas.restore()
            if (dozing) {
                snore.textSize = size * 0.22f
                canvas.drawText("z", left + size * 0.78f, top + size * 0.12f, snore)
                snore.textSize = size * 0.30f
                canvas.drawText("Z", left + size * 0.95f, top - size * 0.08f, snore)
            } else {
                snore.textSize = size * 0.28f
                canvas.drawText("…", left + size * 0.82f, top + size * 0.05f, snore)
            }
        }
        return bitmap
    }

    private fun sprite(context: Context, avatar: String): Bitmap? =
        try {
            context.assets.open("public/avatars/$avatar.webp").use(BitmapFactory::decodeStream)
        } catch (error: IOException) {
            Log.w(TRIGGERS_TAG, "no avatar $avatar", error)
            null
        }
}
