package dev.geminixiang.pimobile

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.UUID

private const val TAG = "PiSpeaker"
private const val REPLACED = "replaced by newer speech"
private const val BREAKS = "。！？!?；;\n"

internal class Speaker private constructor(context: Context) {
    private val context = context.applicationContext
    private val audio = this.context.getSystemService(AudioManager::class.java)
    private val focus =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            ).build()
    private var engine: TextToSpeech? = null
    private var ready: Boolean? = null
    private val waiting = mutableListOf<() -> Unit>()
    private var current: String? = null
    private var done: ((String?) -> Unit)? = null

    private fun withEngine(action: () -> Unit) {
        if (ready == true) {
            action()
            return
        }
        waiting.add(action)
        if (engine != null) return
        engine =
            TextToSpeech(context) { status ->
                synchronized(this@Speaker) {
                    val started = status == TextToSpeech.SUCCESS
                    ready = started
                    if (started) {
                        engine?.setAudioAttributes(focus.audioAttributes)
                        engine?.setOnUtteranceProgressListener(Progress())
                    }
                    val actions = waiting.toList()
                    waiting.clear()
                    if (!started) {
                        engine = null
                        ready = null
                    }
                    actions.forEach { it() }
                }
            }
    }

    @Synchronized
    fun speak(text: String, language: String, done: (String?) -> Unit) {
        stop(REPLACED)
        withEngine {
            synchronized(this@Speaker) {
                stop(REPLACED)
                val tts = engine ?: return@withEngine done("this phone has no text-to-speech engine")
                val locale = Locale.forLanguageTag(language)
                if (tts.isLanguageAvailable(locale) < TextToSpeech.LANG_AVAILABLE) return@withEngine done("the text-to-speech engine has no voice for $language")
                tts.setLanguage(locale)
                val id = UUID.randomUUID().toString()
                current = id
                this.done = done
                audio.requestAudioFocus(focus)
                val parts = split(text, minOf(TextToSpeech.getMaxSpeechInputLength(), 1000))
                parts.forEachIndexed { index, part ->
                    tts.speak(part, TextToSpeech.QUEUE_ADD, Bundle(), if (index == parts.lastIndex) id else "$id/$index")
                }
            }
        }
    }

    @Synchronized
    fun stop(reason: String) {
        if (current == null) return
        engine?.stop()
        finish(reason)
    }

    @Synchronized
    private fun finish(error: String?) {
        val callback = done
        current = null
        done = null
        audio.abandonAudioFocusRequest(focus)
        callback?.invoke(error)
    }

    private inner class Progress : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}

        override fun onDone(utteranceId: String?) {
            synchronized(this@Speaker) {
                if (current != null && utteranceId == current) finish(null)
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = onError(utteranceId, TextToSpeech.ERROR)

        override fun onError(utteranceId: String?, errorCode: Int) {
            synchronized(this@Speaker) {
                val id = current ?: return
                if (utteranceId?.startsWith(id) != true) return
                Log.w(TAG, "speech failed $errorCode")
                engine?.stop()
                finish("text-to-speech failed ($errorCode)")
            }
        }
    }

    companion object {
        private var instance: Speaker? = null

        @Synchronized
        fun get(context: Context): Speaker = instance ?: Speaker(context).also { instance = it }

        @Synchronized
        fun stopIfSpeaking() {
            instance?.stop("stopped")
        }

        private fun split(text: String, max: Int): List<String> =
            buildList {
                var rest = text.trim()
                while (rest.length > max) {
                    val cut =
                        (max downTo max / 2 + 1).firstOrNull { end ->
                            val c = rest[end - 1]
                            c in BREAKS || (c == '.' && end < rest.length && rest[end] == ' ')
                        } ?: max
                    add(rest.substring(0, cut).trim())
                    rest = rest.substring(cut).trim()
                }
                if (rest.isNotEmpty()) add(rest)
            }
    }
}
