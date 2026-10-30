package dev.geminixiang.pimobile

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.util.concurrent.Executor

internal sealed interface Outcome<out T> {
    data class Ok<T>(val value: T) : Outcome<T>

    data class Stopped(val reason: String) : Outcome<Nothing>
}

internal val DONE: Outcome<JSObject?> = Outcome.Ok(null)

internal inline fun <T> Outcome<T>.valueOr(stop: (Outcome.Stopped) -> Nothing): T =
    when (this) {
        is Outcome.Ok -> value
        is Outcome.Stopped -> stop(this)
    }

internal fun Executor.reply(call: PluginCall, job: () -> Outcome<JSObject?>) =
    execute {
        val outcome =
            try {
                job()
            } catch (failure: Exception) {
                Outcome.Stopped(failure.message.toString())
            }
        when (outcome) {
            is Outcome.Stopped -> call.reject(outcome.reason)
            is Outcome.Ok -> if (outcome.value == null) call.resolve() else call.resolve(outcome.value)
        }
    }
