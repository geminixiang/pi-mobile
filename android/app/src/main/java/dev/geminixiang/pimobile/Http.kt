package dev.geminixiang.pimobile

import dev.geminixiang.pimobile.Background.Failure
import java.net.HttpURLConnection
import java.net.URL

private const val CONNECT_MS = 15_000
private const val MAX_REDIRECTS = 5
private const val USER_AGENT = "Mozilla/5.0 (Linux; Android 16) pi-mobile"

internal class Fetched(val connection: HttpURLConnection, val url: URL, val status: Int)

internal object Http {
    fun open(url: URL, readMs: Int, method: String = "GET", headers: Map<String, String> = emptyMap()): HttpURLConnection {
        if (url.protocol != "http" && url.protocol != "https") throw Failure("invalid", "url must be http or https")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = CONNECT_MS
        connection.readTimeout = readMs
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("User-Agent", USER_AGENT)
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        return connection
    }

    fun get(start: URL, readMs: Int): Fetched {
        var url = start
        repeat(MAX_REDIRECTS + 1) {
            val connection = open(url, readMs)
            val status = connection.responseCode
            val location = connection.getHeaderField("Location")
            if (status !in 300..399 || location == null) return Fetched(connection, url, status)
            connection.disconnect()
            url = URL(url, location)
        }
        throw Failure("http", "too many redirects: $start")
    }
}
