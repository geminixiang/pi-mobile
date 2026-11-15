package dev.geminixiang.agentscreen

import android.content.Context
import com.flyfishxu.kadb.Kadb
import com.flyfishxu.kadb.cert.KadbCert
import com.flyfishxu.kadb.cert.OkioFilePrivateKeyStore
import com.flyfishxu.kadb.exception.AdbAuthException
import com.flyfishxu.kadb.exception.AdbPairAuthException
import com.flyfishxu.kadb.shell.AdbShellPacket
import com.flyfishxu.kadb.shell.AdbShellStream
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toOkioPath
import java.io.File

private const val LOCAL = "127.0.0.1"
private const val CONNECT_MS = 3000

sealed interface Outcome {
    data object Done : Outcome
    data class Failed(val reason: String) : Outcome
}

sealed interface Opened {
    data class Ready(val display: Int) : Opened
    data class Failed(val reason: String) : Opened
}

class AgentScreen(private val context: Context) {
    private sealed interface Link {
        data object Closed : Link
        data class Open(val adb: Kadb, val server: AdbShellStream, val display: Int) : Link
    }

    private var link: Link = Link.Closed

    init {
        KadbCert.configure(OkioFilePrivateKeyStore(File(context.filesDir, "agent-screen-key.pem").toOkioPath()))
    }

    val display: Int? get() = (link as? Link.Open)?.display

    fun pair(code: String): Outcome {
        val port = ownPort(context, PAIRING) ?: return Outcome.Failed("pairing_closed")
        return runCatching { runBlocking { Kadb.pair(LOCAL, port, code) } }
            .fold({ Outcome.Done }, { Outcome.Failed(if (it is AdbPairAuthException) "wrong_code" else describe(it)) })
    }

    fun open(width: Int, height: Int, dpi: Int): Opened {
        (link as? Link.Open)?.let { if (it.adb.connectionCheck()) return Opened.Ready(it.display) else close() }
        val port = ownPort(context, CONNECT) ?: return Opened.Failed("debugging_off")
        val adb = runCatching { Kadb.create(LOCAL, port, connectTimeout = CONNECT_MS).also { it.shell("true") } }
            .getOrElse { return Opened.Failed(if (it is AdbAuthException) "not_paired" else describe(it)) }
        val apk = context.applicationInfo.sourceDir
        val server = adb.openShell("CLASSPATH=$apk app_process / ${DisplayServer::class.java.name} $width $height $dpi")
        val output = StringBuilder()
        val display = readLine(server, output, "display ")?.toIntOrNull()
            ?: return Opened.Failed("the display server did not start: $output").also { server.close(); adb.close() }
        link = Link.Open(adb, server, display)
        return Opened.Ready(display)
    }

    fun key(display: Int, code: String): Boolean {
        val open = link as? Link.Open ?: return false
        if (open.display != display) return false
        return run(open, "input -d $display keyevent $code") == Outcome.Done
    }

    fun close() {
        val open = link as? Link.Open ?: return
        link = Link.Closed
        runCatching { open.server.closeStdin() }
        open.server.close()
        open.adb.close()
    }

    private fun run(open: Link.Open, command: String): Outcome {
        val response = runCatching { open.adb.shell(command) }.getOrElse { return Outcome.Failed(describe(it)) }
        return if (response.exitCode == 0) Outcome.Done else Outcome.Failed(response.allOutput.trim())
    }

    private fun readLine(server: AdbShellStream, output: StringBuilder, prefix: String): String? {
        while (true) {
            val line = output.indexOf("\n").takeIf { it >= 0 }?.let { end -> output.substring(0, end).also { output.delete(0, end + 1) } }
            if (line != null && line.startsWith(prefix)) return line.removePrefix(prefix)
            if (line != null) continue
            when (val packet = server.read()) {
                is AdbShellPacket.StdOut -> output.append(String(packet.payload))
                is AdbShellPacket.StdError -> output.append(String(packet.payload))
                is AdbShellPacket.Exit -> return null
            }
        }
    }

    private fun describe(error: Throwable) = error.message ?: error.javaClass.simpleName
}
