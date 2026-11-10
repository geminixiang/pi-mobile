package dev.geminixiang.pimobile

import com.getcapacitor.PluginCall
import java.util.concurrent.Executor
import java.util.concurrent.Executors

object Background {
    class Failure(val code: String, message: String) : Exception(message)

    private val shared = Executors.newCachedThreadPool()

    fun run(call: PluginCall, job: () -> Unit): Unit = run(shared, call, job)

    fun run(executor: Executor, call: PluginCall, job: () -> Unit): Unit =
        executor.execute {
            try {
                job()
            } catch (error: Exception) {
                call.reject(error.message.toString(), if (error is Failure) error.code else "io")
            }
        }
}
