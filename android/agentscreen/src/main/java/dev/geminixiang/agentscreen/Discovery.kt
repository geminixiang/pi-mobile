package dev.geminixiang.agentscreen

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.net.NetworkInterface
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

internal const val PAIRING = "_adb-tls-pairing._tcp"
internal const val CONNECT = "_adb-tls-connect._tcp"
private const val SEARCH_SECONDS = 4L

internal fun ownPort(context: Context, type: String): Int? {
    val found = CompletableFuture<Int?>()
    return discoverOwn(context, type, found::complete).use { runCatching { found.get(SEARCH_SECONDS, TimeUnit.SECONDS) }.getOrNull() }
}

internal fun discoverOwn(context: Context, type: String, found: (Int?) -> Unit): AutoCloseable {
    val nsd = context.getSystemService(NsdManager::class.java)
    val ours = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }.toSet()
    val resolving = CopyOnWriteArrayList<NsdManager.ServiceInfoCallback>()
    val listener = object : NsdManager.DiscoveryListener {
        override fun onServiceFound(service: NsdServiceInfo) {
            nsd.registerServiceInfoCallback(service, context.mainExecutor, object : NsdManager.ServiceInfoCallback {
                override fun onServiceUpdated(info: NsdServiceInfo) {
                    if (info.hostAddresses.any { it in ours }) found(info.port)
                }
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
                override fun onServiceLost() = Unit
                override fun onServiceInfoCallbackUnregistered() = Unit
            }.also(resolving::add))
        }
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            found(null)
        }
        override fun onDiscoveryStarted(serviceType: String) = Unit
        override fun onDiscoveryStopped(serviceType: String) = Unit
        override fun onServiceLost(service: NsdServiceInfo) = Unit
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
    }
    nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
    return AutoCloseable {
        resolving.forEach { runCatching { nsd.unregisterServiceInfoCallback(it) } }
        runCatching { nsd.stopServiceDiscovery(listener) }
    }
}
