package dev.geminixiang.pimobile;

import android.content.Intent;
import android.speech.RecognitionService;

/**
 * Android lists an assistant only with a recognition service. pi's dictation uses the system recognizer
 * (VoicePlugin), so this one recognizes nothing.
 */
public class AssistRecognitionService extends RecognitionService {
    @Override
    protected void onStartListening(Intent intent, Callback listener) {
        try {
            listener.error(android.speech.SpeechRecognizer.ERROR_CLIENT);
        } catch (android.os.RemoteException ignored) {
            // The caller went away.
        }
    }

    @Override
    protected void onCancel(Callback listener) {}

    @Override
    protected void onStopListening(Callback listener) {}
}
