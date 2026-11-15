package dev.geminixiang.agentscreen

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.net.NetworkInterface
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal const val PAIRING = "_adb-tls-pairing._tcp"
internal const val CONNECT = "_adb-tls-connect._tcp"
private const val SEARCH_SECONDS = 4L

internal fun ownPort(context: Context, type: String): Int? {
    val nsd = context.getSystemService(NsdManager::class.java)
    val ours = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }.toSet()
    val found = CompletableFuture<Int?>()
    val listener = object : NsdManager.DiscoveryListener {
        override fun onServiceFound(service: NsdServiceInfo) {
            nsd.registerServiceInfoCallback(service, context.mainExecutor, object : NsdManager.ServiceInfoCallback {
                override fun onServiceUpdated(info: NsdServiceInfo) {
                    if (info.hostAddresses.any { it in ours }) found.complete(info.port)
                    nsd.unregisterServiceInfoCallback(this)
                }
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
                override fun onServiceLost() = Unit
                override fun onServiceInfoCallbackUnregistered() = Unit
            })
        }
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            found.complete(null)
        }
        override fun onDiscoveryStarted(serviceType: String) = Unit
        override fun onDiscoveryStopped(serviceType: String) = Unit
        override fun onServiceLost(service: NsdServiceInfo) = Unit
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
    }
    nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
    val port = runCatching { found.get(SEARCH_SECONDS, TimeUnit.SECONDS) }.getOrNull()
    runCatching { nsd.stopServiceDiscovery(listener) }
    return port
}
