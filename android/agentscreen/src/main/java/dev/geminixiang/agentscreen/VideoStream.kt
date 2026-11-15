package dev.geminixiang.agentscreen

import com.flyfishxu.kadb.shell.AdbShellPacket
import com.flyfishxu.kadb.shell.AdbShellStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.IOException

internal class VideoStream(private val server: AdbShellStream) : InputStream() {
    private var bytes = ByteArray(0)
    private var at = 0

    override fun read(): Int {
        if (!availablePacket()) return -1
        return bytes[at++].toInt() and 255
    }

    override fun read(target: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (!availablePacket()) return -1
        val count = minOf(length, bytes.size - at)
        bytes.copyInto(target, offset, at, at + count)
        at += count
        return count
    }

    private fun availablePacket(): Boolean {
        while (at == bytes.size) {
            when (val packet = server.read()) {
                is AdbShellPacket.StdOut -> { bytes = packet.payload; at = 0 }
                is AdbShellPacket.StdError -> throw IOException(String(packet.payload))
                is AdbShellPacket.Exit -> return false
            }
        }
        return true
    }
}

internal fun receive(server: AdbShellStream, frame: (Int, ByteArray, Long, Int) -> Unit) {
    val input = DataInputStream(VideoStream(server))
    while (true) {
        val generation = input.readInt()
        val size = input.readInt()
        val pts = input.readLong()
        val flags = input.readInt()
        if (size !in 0..2_000_000) throw IOException("invalid_video_packet")
        val bytes = ByteArray(size)
        input.readFully(bytes)
        frame(generation, bytes, pts, flags)
    }
}
