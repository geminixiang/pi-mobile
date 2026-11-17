package dev.geminixiang.agentscreen

import android.content.Context
import android.provider.Settings
import android.view.Surface
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
        data class Open(val adb: Kadb, val server: AdbShellStream, val display: Int, val width: Int, val height: Int) : Link
    }

    private sealed interface Connection {
        data class Ready(val adb: Kadb) : Connection
        data class Failed(val reason: String) : Connection
    }

    @Volatile private var link: Link = Link.Closed
    @Volatile private var stopped: String? = null
    private val videoLock = Any()
    private var generation = 0
    private var decoder: VideoDecoder? = null
    private val paired = File(context.filesDir, "agent-screen-paired")
    var onFailure: (String) -> Unit = {}

    init {
        KadbCert.configure(OkioFilePrivateKeyStore(File(context.filesDir, "agent-screen-key.pem").toOkioPath()))
    }

    val display: Int? get() = (link as? Link.Open)?.display
    val aspect: Float get() {
        val open = link as? Link.Open
        val metrics = context.resources.displayMetrics
        return videoSize(open?.width ?: metrics.widthPixels).toFloat() / videoSize(open?.height ?: metrics.heightPixels)
    }

    val developerOptions: Boolean
        get() = Settings.Global.getInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0

    fun pair(code: String): Outcome {
        val port = ownPort(context, PAIRING) ?: return Outcome.Failed(if (ownPort(context, CONNECT) == null) "debugging_off" else "pairing_closed")
        return pair(code, port)
    }

    fun watchPairing(found: (Int) -> Unit, failed: () -> Unit): AutoCloseable =
        discoverOwn(context, PAIRING) { port -> if (port == null) failed() else found(port) }

    fun pair(code: String, port: Int): Outcome = runCatching { runBlocking { Kadb.pair(LOCAL, port, code) } }
        .fold({ paired.createNewFile(); Outcome.Done }, { Outcome.Failed(if (it is AdbPairAuthException) "wrong_code" else describe(it)) })

    fun status(): Outcome {
        if (!developerOptions) return Outcome.Failed("developer_off")
        if ((link as? Link.Open)?.adb?.connectionCheck() == true) return Outcome.Done
        return when (val connection = connect()) {
            is Connection.Ready -> Outcome.Done.also { connection.adb.close() }
            is Connection.Failed -> Outcome.Failed(connection.reason)
        }
    }

    fun open(width: Int, height: Int, dpi: Int): Opened {
        (link as? Link.Open)?.let { if (stopped != "display_disconnected" && it.adb.connectionCheck()) return Opened.Ready(it.display) else close() }
        val adb = when (val connection = connect()) {
            is Connection.Ready -> connection.adb
            is Connection.Failed -> return Opened.Failed(connection.reason)
        }
        val apk = context.applicationInfo.sourceDir
        val server = adb.openShell("CLASSPATH=$apk app_process / ${DisplayServer::class.java.name} $width $height $dpi")
        val output = StringBuilder()
        val display = readLine(server, output, "display ")?.toIntOrNull()
            ?: return Opened.Failed("the display server did not start: $output").also { server.close(); adb.close() }
        val open = Link.Open(adb, server, display, width, height)
        link = open
        stopped = null
        Thread({
            runCatching {
                receive(server) { id, bytes, pts, flags ->
                    synchronized(videoLock) {
                        if (id == generation && decoder != null) {
                            if (flags == -1) onFailure(String(bytes)) else decoder?.frame(bytes, pts, flags)
                        }
                    }
                }
            }.onFailure {
                if (link === open) {
                    stopped = "display_disconnected"
                    onFailure(describe(it))
                }
            }
        }, "preview-stream").start()
        return Opened.Ready(display)
    }

    fun key(display: Int, code: String): Boolean {
        val open = link as? Link.Open ?: return false
        if (open.display != display) return false
        return run(open, "input -d $display keyevent $code") == Outcome.Done
    }

    fun reason(display: Int): String? = if (display == this.display) stopped else null

    fun watch(surface: Surface): Outcome {
        val open = link as? Link.Open ?: return Outcome.Failed("display_closed")
        stopped?.let { return Outcome.Failed(it) }
        return runCatching {
            synchronized(videoLock) {
                decoder?.close()
                decoder = null
                generation++
                decoder = VideoDecoder(surface, open.width, open.height, onFailure)
                open.server.write("watch on $generation\n")
            }
            Outcome.Done
        }.getOrElse { unwatch(); Outcome.Failed(describe(it)) }
    }

    fun unwatch(): Outcome {
        synchronized(videoLock) {
            decoder?.close()
            decoder = null
        }
        val open = link as? Link.Open ?: return Outcome.Done
        return runCatching { open.server.write("watch off\n"); Outcome.Done }
            .getOrElse { Outcome.Failed(describe(it)) }
    }

    fun takeover(): Outcome {
        val open = link as? Link.Open ?: return Outcome.Failed("display_closed")
        stopped?.let { return Outcome.Failed(it) }
        val listed = runCatching { open.adb.shell("am stack list") }.getOrElse { return Outcome.Failed(describe(it)) }
        val root = listed.allOutput.split("\n\n").firstOrNull { task ->
            val header = task.lineSequence().first()
            header.startsWith("RootTask id=") && header.split(' ').contains("displayId=${open.display}") && task.contains("visible=true")
        }?.substringAfter("RootTask id=")?.substringBefore(' ')?.toIntOrNull() ?: return Outcome.Failed("task_not_found")
        val moved = run(open, "am display move-stack $root 0")
        if (moved is Outcome.Failed) return moved
        stopped = "takeover_unconfirmed"
        val verified = runCatching { open.adb.shell("am stack list") }.getOrElse { return Outcome.Failed(describe(it)) }
        if (verified.allOutput.lineSequence().none { it.startsWith("RootTask id=$root ") && it.split(' ').contains("displayId=0") }) {
            return Outcome.Failed("task_not_moved")
        }
        stopped = "taken_over"
        val unwatched = unwatch()
        if (unwatched is Outcome.Failed) onFailure(unwatched.reason)
        return Outcome.Done
    }

    fun close() {
        val open = link as? Link.Open ?: return
        val unwatched = unwatch()
        if (unwatched is Outcome.Failed) onFailure(unwatched.reason)
        link = Link.Closed
        runCatching { open.server.closeStdin() }.onFailure { onFailure(describe(it)) }
        open.server.close()
        open.adb.close()
    }

    private fun connect(): Connection {
        val port = ownPort(context, CONNECT) ?: return Connection.Failed(if (paired.exists()) "debugging_off" else "not_paired")
        val adb = runCatching { Kadb.create(LOCAL, port, connectTimeout = CONNECT_MS) }.getOrElse { return Connection.Failed(describe(it)) }
        return runCatching { adb.shell("true") }.fold(
            { paired.createNewFile(); Connection.Ready(adb) },
            { failure ->
                adb.close()
                if (failure !is AdbAuthException) return Connection.Failed(describe(failure))
                paired.delete()
                Connection.Failed("not_paired")
            },
        )
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
