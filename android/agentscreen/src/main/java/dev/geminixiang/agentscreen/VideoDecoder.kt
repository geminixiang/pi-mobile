package dev.geminixiang.agentscreen

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal class VideoDecoder(surface: Surface, width: Int, height: Int, private val failed: (String) -> Unit) : AutoCloseable {
    private val thread = HandlerThread("preview-decoder").apply { start() }
    private val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    private val inputs = LinkedBlockingQueue<Int>()
    private val started = SystemClock.elapsedRealtime()
    private var frames = 0L
    private var lastFrame = started
    private var bytes = 0L
    private var lastLog = started
    private var rendered = false

    init {
        codec.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) { inputs.offer(index) }
            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = Unit
            override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) { failed(error.diagnosticInfo) }
            override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                codec.releaseOutputBuffer(index, true)
            }
        }, Handler(thread.looper))
        codec.setOnFrameRenderedListener({ _, _, _ ->
            if (!rendered) {
                rendered = true
                Log.i("AgentPreview", "first_frame_ms=${SystemClock.elapsedRealtime() - started}")
            }
        }, Handler(thread.looper))
        codec.configure(MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, videoSize(width), videoSize(height)), surface, null, 0)
        codec.start()
        Log.i("AgentPreview", "watch_on size=${videoSize(width)}x${videoSize(height)} codec=${codec.name}")
    }

    fun frame(data: ByteArray, pts: Long, flags: Int) {
        val index = inputs.poll(2, TimeUnit.SECONDS)
        if (index == null) { failed("decoder_timeout"); return }
        val buffer = codec.getInputBuffer(index)
        if (buffer == null || buffer.capacity() < data.size) { failed("decoder_buffer"); return }
        buffer.clear()
        buffer.put(data)
        codec.queueInputBuffer(index, 0, data.size, pts, flags)
        bytes += data.size
        if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
            frames++
            lastFrame = SystemClock.elapsedRealtime()
        }
        if (SystemClock.elapsedRealtime() - lastLog >= 5000) stats("watching")
    }

    private fun stats(state: String) {
        lastLog = SystemClock.elapsedRealtime()
        Log.i("AgentPreview", "$state elapsed_ms=${lastLog - started} frames=$frames bytes=$bytes last_frame_ms=${lastFrame - started}")
    }

    override fun close() {
        stats("watch_off")
        codec.stop()
        codec.release()
        thread.quitSafely()
    }
}
