package dev.geminixiang.agentscreen

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Handler
import android.view.Surface
import java.io.DataOutputStream

internal fun videoSize(pixels: Int) = maxOf(16, pixels / 3 / 16 * 16)

internal class VideoEncoder(width: Int, height: Int, generation: Int, handler: Handler, output: DataOutputStream) : AutoCloseable {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    val surface: Surface

    init {
        codec.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit
            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = Unit
            override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
                packet(output, generation, 0, -1, error.diagnosticInfo.toByteArray())
            }
            override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                val buffer = codec.getOutputBuffer(index)
                if (buffer != null && info.size > 0) {
                    buffer.position(info.offset)
                    buffer.limit(info.offset + info.size)
                    val bytes = ByteArray(info.size)
                    buffer.get(bytes)
                    packet(output, generation, info.presentationTimeUs, info.flags, bytes)
                }
                codec.releaseOutputBuffer(index, false)
            }
        }, handler)
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, videoSize(width), videoSize(height)).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 250_000)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
            setInteger(MediaFormat.KEY_FRAME_RATE, 15)
            setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, 15f)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, -1)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = codec.createInputSurface()
        codec.start()
    }

    override fun close() {
        codec.stop()
        codec.release()
        surface.release()
    }
}

internal fun packet(output: DataOutputStream, generation: Int, pts: Long, flags: Int, bytes: ByteArray) {
    synchronized(output) {
        output.writeInt(generation)
        output.writeInt(bytes.size)
        output.writeLong(pts)
        output.writeInt(flags)
        output.write(bytes)
        output.flush()
    }
}
