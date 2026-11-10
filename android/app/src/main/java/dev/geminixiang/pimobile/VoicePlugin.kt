package dev.geminixiang.pimobile

import android.Manifest
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(name = "Voice", permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class VoicePlugin : Plugin() {
    private var recognizer: SpeechRecognizer? = null

    @PluginMethod
    fun available(call: PluginCall) {
        call.resolve(JSObject().put("available", SpeechRecognizer.isRecognitionAvailable(context)))
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult")
            return
        }
        begin(call)
    }

    @PermissionCallback
    private fun microphoneResult(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call) else call.reject("需要麥克風權限才能語音輸入", "permission")
    }

    private fun begin(call: PluginCall) {
        val language = call.getString("language", "zh-TW")
        activity.runOnUiThread {
            destroy()
            val created = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = created
            created.setRecognitionListener(Listener())
            val intent =
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
                    .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
            created.startListening(intent)
            call.resolve()
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity.runOnUiThread {
            recognizer?.stopListening()
            call.resolve()
        }
    }

    @PluginMethod
    fun speak(call: PluginCall) {
        val text = call.getString("text", "").orEmpty()
        if (text.isBlank()) {
            call.reject("nothing to say")
            return
        }
        Speaker.get(context).speak(text, call.getString("language", "zh-TW").orEmpty()) { error ->
            val result = JSObject().put("spoken", error == null)
            if (error != null) result.put("reason", error)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun stopSpeaking(call: PluginCall) {
        Speaker.stopIfSpeaking()
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        activity.runOnUiThread {
            destroy()
            notifyListeners("end", JSObject())
            call.resolve()
        }
    }

    private fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }

    private inner class Listener : RecognitionListener {
        override fun onPartialResults(partial: Bundle?) = notifyListeners("partial", JSObject().put("text", first(partial)))

        override fun onResults(results: Bundle?) {
            notifyListeners("final", JSObject().put("text", first(results)))
            finish()
        }

        override fun onError(error: Int) {
            notifyListeners("error", JSObject().put("code", error).put("message", describe(error)))
            finish()
        }

        override fun onRmsChanged(rmsdB: Float) = notifyListeners("level", JSObject().put("rms", rmsdB.toDouble()))

        private fun finish() {
            destroy()
            notifyListeners("end", JSObject())
        }

        override fun onReadyForSpeech(params: Bundle?) = notifyListeners("ready", JSObject())

        override fun onBeginningOfSpeech() {}

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {}

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private companion object {
        fun first(results: Bundle?): String = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

        fun describe(error: Int) =
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "沒有聽到內容"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "語音辨識需要網路"
                SpeechRecognizer.ERROR_AUDIO -> "麥克風無法使用"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "需要麥克風權限"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "語音辨識正忙，請再試一次"
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "不支援這個語言"
                else -> "語音辨識失敗（$error）"
            }
    }
}
