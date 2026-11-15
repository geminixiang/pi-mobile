package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

internal class AgentPreview(
    private val service: AccessibilityService,
    aspect: Float,
    private val watch: (Surface) -> Unit,
    private val unwatch: (() -> Unit) -> Unit,
    private val takeover: () -> Unit,
) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private val metrics = service.resources.displayMetrics
    private fun dp(value: Int) = (value * metrics.density).roundToInt()
    private val previewWidth = dp(136)
    private val videoHeight = (previewWidth / aspect).roundToInt()
    private val layout = WindowManager.LayoutParams(
        previewWidth, videoHeight + dp(44), WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        android.graphics.PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.LEFT; title = "背景螢幕預覽" }
    private val step = TextView(service).apply {
        text = "背景螢幕"
        textSize = 13f
        setTextColor(Color.rgb(37, 47, 61))
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(12), 0, dp(44), 0)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
    }
    private val root = FrameLayout(service).apply {
        background = GradientDrawable().apply { setColor(Color.rgb(244, 242, 240)); cornerRadius = dp(16).toFloat() }
        clipToOutline = true
        elevation = dp(8).toFloat()
    }
    private var shown = false
    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragged = false

    init {
        val video = TextureView(service).apply {
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                private var surface: Surface? = null
                override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                    val target = Surface(texture)
                    surface = target
                    watch(target)
                }
                override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit
                override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
                override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                    val target = surface
                    surface = null
                    unwatch { target?.release(); texture.release() }
                    return false
                }
            }
        }
        val content = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            addView(video, LinearLayout.LayoutParams(previewWidth, videoHeight))
            addView(step, LinearLayout.LayoutParams(previewWidth, dp(44)))
            contentDescription = "接手背景螢幕"
            setOnClickListener { step.text = "接手中…"; takeover() }
            setOnTouchListener { view, event -> drag(view, event) }
        }
        root.addView(content)
        root.addView(TextView(service).apply {
            text = "×"
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(75, 96, 124))
            contentDescription = "隱藏背景螢幕預覽"
            setOnClickListener { hide() }
        }, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.BOTTOM or Gravity.RIGHT))
    }

    fun show() {
        if (shown) return
        val bounds = windows.currentWindowMetrics.bounds
        val insets = windows.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
        layout.x = bounds.width() - previewWidth - dp(12)
        layout.y = bounds.height() - insets.top - insets.bottom - layout.height - dp(12)
        windows.addView(root, layout)
        shown = true
    }

    fun hide() {
        if (!shown) return
        shown = false
        windows.removeViewImmediate(root)
    }

    fun step(action: String) {
        step.text = when (action) {
            "read" -> "讀取畫面"
            "tap" -> "點按"
            "long_press" -> "長按"
            "swipe" -> "滑動"
            "scroll" -> "捲動"
            "type" -> "輸入文字"
            "clear" -> "清除文字"
            "key" -> "按鍵"
            "open" -> "開啟 App"
            "wait" -> "等待畫面"
            else -> "背景螢幕"
        }
    }

    fun failed() { step.text = "預覽失敗" }
    fun takeoverFailed() { step.text = "接手失敗" }

    private fun drag(view: View, event: MotionEvent): Boolean {
        val bounds = windows.currentWindowMetrics.bounds
        val insets = windows.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
        val left = dp(12)
        val right = (bounds.width() - previewWidth - dp(12)).coerceAtLeast(left)
        val top = dp(12)
        val bottom = (bounds.height() - insets.top - insets.bottom - layout.height - dp(12)).coerceAtLeast(top)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX; downY = event.rawY
                startX = layout.x; startY = layout.y; dragged = false
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX
                val dy = event.rawY - downY
                if (abs(dx) + abs(dy) > ViewConfiguration.get(service).scaledTouchSlop) dragged = true
                if (dragged) {
                    layout.x = (startX + dx.roundToInt()).coerceIn(left, right)
                    layout.y = (startY + dy.roundToInt()).coerceIn(top, bottom)
                    windows.updateViewLayout(root, layout)
                }
            }
            MotionEvent.ACTION_UP -> {
                if (!dragged) { view.performClick(); return true }
                layout.x = if (layout.x < (left + right) / 2) left else right
                layout.y = if (layout.y < (top + bottom) / 2) top else bottom
                windows.updateViewLayout(root, layout)
            }
            MotionEvent.ACTION_CANCEL -> dragged = false
        }
        return true
    }
}
