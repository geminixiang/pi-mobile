package dev.geminixiang.pimobile;

import android.content.Intent;
import android.speech.RecognitionService;

public class AssistRecognitionService extends RecognitionService {
    @Override
    protected void onStartListening(Intent intent, Callback listener) {
        try {
            listener.error(android.speech.SpeechRecognizer.ERROR_CLIENT);
        } catch (android.os.RemoteException error) {
            android.util.Log.w("pi.assist", "the recognition client is gone", error);
        }
    }

    @Override
    protected void onCancel(Callback listener) {}

    @Override
    protected void onStopListening(Callback listener) {}
}
