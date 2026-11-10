package dev.geminixiang.pimobile

import android.content.Intent
import android.os.RemoteException
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.util.Log

class AssistRecognitionService : RecognitionService() {
    override fun onStartListening(intent: Intent, listener: Callback) {
        try {
            listener.error(SpeechRecognizer.ERROR_CLIENT)
        } catch (error: RemoteException) {
            Log.w("pi.assist", "the recognition client is gone", error)
        }
    }

    override fun onCancel(listener: Callback) {}

    override fun onStopListening(listener: Callback) {}
}
