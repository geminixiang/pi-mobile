package dev.geminixiang.pimobile

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.geminixiang.pimobile.Background.Failure
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URL
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.Executors

private val BOT = Regex("[A-Za-z0-9_-]{1,64}")
private const val DOWNLOAD_READ_MS = 60_000

@CapacitorPlugin(name = "BotFiles")
class BotFilesPlugin : Plugin() {
    private val work = Executors.newFixedThreadPool(4)

    private fun bots() = File(context.filesDir, "bots")

    private fun botRoot(call: PluginCall): File {
        val bot = call.getString("bot", "").orEmpty()
        if (!BOT.matches(bot)) throw Failure("invalid", "bad bot id")
        return File(bots(), bot)
    }

    private fun resolve(call: PluginCall, key: String): File {
        val root = botRoot(call)
        val path = call.getString(key, "").orEmpty()
        if (path.startsWith("/") || path.contains('\u0000')) throw Failure("invalid", "path must be relative: $path")
        val file = if (path.isEmpty()) root else File(root, path)
        val rootPath = root.canonicalPath
        val filePath = file.canonicalPath
        if (filePath != rootPath && !filePath.startsWith(rootPath + File.separator)) throw Failure("invalid", "outside the folder: $path")
        return file
    }

    @PluginMethod
    fun stat(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            when {
                file.exists() -> call.resolve(info(file))
                file == botRoot(call) -> call.resolve(JSObject().put("name", "").put("kind", "directory").put("size", 0).put("mtimeMs", 0).put("executable", false))
                else -> throw notFound(call.getString("path"))
            }
        }

    @PluginMethod
    fun exists(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            call.resolve(JSObject().put("exists", file.exists() || file == botRoot(call)))
        }

    @PluginMethod
    fun list(call: PluginCall) =
        Background.run(work, call) {
            val dir = resolve(call, "path")
            val entries = JSArray()
            if (dir.exists()) {
                if (!dir.isDirectory) throw Failure("not_directory", "Not a directory: ${call.getString("path")}")
                dir.listFiles()?.forEach { entries.put(info(it)) }
            } else if (dir != botRoot(call)) {
                throw notFound(call.getString("path"))
            }
            call.resolve(JSObject().put("entries", entries))
        }

    @PluginMethod
    fun read(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (!file.exists()) throw notFound(call.getString("path"))
            if (file.isDirectory) throw Failure("is_directory", "Is a directory: ${call.getString("path")}")
            RandomAccessFile(file, "r").use { input ->
                val size = input.length()
                val start = number(call, "offset", 0L).coerceIn(0, size)
                val length = number(call, "length", size - start).coerceIn(0, size - start)
                if (length > Int.MAX_VALUE - 8) throw Failure("invalid", "read too large")
                val bytes = ByteArray(length.toInt())
                input.seek(start)
                input.readFully(bytes)
                val out = JSObject().put("size", size)
                if (call.getBoolean("text", false) == true) out.put("text", String(bytes, Charsets.UTF_8)) else out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                call.resolve(out)
            }
        }

    @PluginMethod
    fun write(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (file == botRoot(call) || file.isDirectory) throw Failure("is_directory", "Is a directory: ${call.getString("path")}")
            val parent = file.parentFile
            if (parent != null && !parent.isDirectory) {
                if (parent.exists()) throw Failure("not_directory", "Not a directory: ${parent.name}")
                if (!parent.mkdirs() && !parent.isDirectory) throw IOException("cannot create ${parent.name}")
            }
            val bytes = call.getString("text")?.toByteArray(Charsets.UTF_8) ?: Base64.decode(call.getString("data", "").orEmpty(), Base64.DEFAULT)
            if (call.getBoolean("append", false) == true) {
                FileOutputStream(file, true).use { it.write(bytes) }
            } else {
                val temp = File.createTempFile(".pi-write-", "", parent)
                FileOutputStream(temp).use { output ->
                    output.write(bytes)
                    output.fd.sync()
                }
                replace(temp, file)
            }
            call.resolve()
        }

    @PluginMethod
    fun truncate(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (!file.exists()) throw notFound(call.getString("path"))
            if (file.isDirectory) throw Failure("is_directory", "Is a directory: ${call.getString("path")}")
            RandomAccessFile(file, "rw").use { it.setLength(number(call, "size", 0L).coerceAtLeast(0)) }
            call.resolve()
        }

    @PluginMethod
    fun create(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            val parent = file.parentFile
            if (parent == null || !parent.isDirectory) throw notFound(call.getString("path"))
            val created = if (call.getBoolean("directory", false) == true) file.mkdir() else file.createNewFile()
            if (!created) throw Failure("exists", "Already exists: ${call.getString("path")}")
            call.resolve()
        }

    @PluginMethod
    fun chmod(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (!file.exists()) throw notFound(call.getString("path"))
            val executable = ((call.getInt("mode", 0) ?: 0) and "111".toInt(8)) != 0
            if (!file.setExecutable(executable, false)) throw IOException("cannot change the mode of ${file.name}")
            call.resolve()
        }

    @PluginMethod
    fun mkdir(call: PluginCall) =
        Background.run(work, call) {
            val dir = resolve(call, "path")
            val recursive = call.getBoolean("recursive", false) == true
            val root = dir == botRoot(call)
            if (dir.isDirectory) {
                if (!recursive && !root) throw Failure("exists", "Already exists: ${call.getString("path")}")
                call.resolve()
                return@run
            }
            if (dir.exists()) throw Failure("not_directory", "Not a directory: ${call.getString("path")}")
            val made = if (recursive || root) dir.mkdirs() else dir.mkdir()
            if (!made && !dir.isDirectory) {
                val parent = dir.parentFile
                if (parent != null && !parent.exists()) throw notFound(call.getString("path"))
                throw IOException("cannot create ${dir.name}")
            }
            call.resolve()
        }

    @PluginMethod
    fun remove(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (!file.exists()) {
                if (call.getBoolean("force", false) == true) {
                    call.resolve()
                    return@run
                }
                throw notFound(call.getString("path"))
            }
            if (file == botRoot(call)) throw Failure("invalid", "cannot remove the folder itself")
            if (file.isDirectory && !file.list().isNullOrEmpty() && call.getBoolean("recursive", false) != true) {
                throw Failure("invalid", "Directory not empty: ${call.getString("path")}")
            }
            deleteTree(file)
            call.resolve()
        }

    @PluginMethod
    fun rename(call: PluginCall) =
        Background.run(work, call) {
            val from = resolve(call, "from")
            val to = resolve(call, "to")
            if (!from.exists()) throw notFound(call.getString("from"))
            val parent = to.parentFile
            if (parent != null && !parent.isDirectory) throw notFound(call.getString("to"))
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
            call.resolve()
        }

    @PluginMethod
    fun download(call: PluginCall) =
        Background.run(work, call) {
            val file = resolve(call, "path")
            if (file == botRoot(call) || file.isDirectory) throw Failure("is_directory", "Is a directory: ${call.getString("path")}")
            val fetched = Http.get(URL(call.getString("url", "").orEmpty()), DOWNLOAD_READ_MS)
            try {
                if (fetched.status >= 400) throw Failure("http", "HTTP ${fetched.status} ${fetched.url}")
                val parent = file.parentFile
                if (parent != null && !parent.isDirectory && !parent.mkdirs() && !parent.isDirectory) throw IOException("cannot create ${parent.name}")
                val temp = File.createTempFile(".pi-write-", "", parent)
                val size =
                    try {
                        fetched.connection.inputStream.use { input ->
                            FileOutputStream(temp).use { output ->
                                val copied = input.transferTo(output)
                                output.fd.sync()
                                copied
                            }
                        }
                    } catch (failure: IOException) {
                        if (!temp.delete()) temp.deleteOnExit()
                        throw failure
                    }
                replace(temp, file)
                call.resolve(JSObject().put("size", size).put("contentType", fetched.connection.contentType.orEmpty()).put("url", fetched.url.toString()))
            } finally {
                fetched.connection.disconnect()
            }
        }

    @PluginMethod
    fun listBots(call: PluginCall) =
        Background.run(work, call) {
            val ids = JSArray()
            bots().listFiles()?.filter { it.isDirectory && BOT.matches(it.name) }?.forEach { ids.put(it.name) }
            call.resolve(JSObject().put("ids", ids))
        }

    @PluginMethod
    fun removeBot(call: PluginCall) =
        Background.run(work, call) {
            val root = botRoot(call)
            if (root.exists()) deleteTree(root)
            call.resolve()
        }

    private companion object {
        fun replace(temp: File, file: File) {
            try {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } catch (unsupported: AtomicMoveNotSupportedException) {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }

        fun number(call: PluginCall, key: String, fallback: Long): Long = (call.data.opt(key) as? Number)?.toLong() ?: fallback

        fun notFound(path: String?) = Failure("not_found", "No such file or directory: $path")

        fun info(file: File): JSObject =
            JSObject()
                .put("name", file.name)
                .put("kind", if (file.isDirectory) "directory" else "file")
                .put("size", if (file.isDirectory) 0 else file.length())
                .put("mtimeMs", file.lastModified())
                .put("executable", file.isFile && file.canExecute())

        fun deleteTree(file: File) {
            if (file.isDirectory && !Files.isSymbolicLink(file.toPath())) file.listFiles()?.forEach(::deleteTree)
            if (!file.delete() && file.exists()) throw IOException("cannot delete ${file.name}")
        }
    }
}
