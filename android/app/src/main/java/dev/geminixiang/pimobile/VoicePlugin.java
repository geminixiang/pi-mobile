package dev.geminixiang.pimobile;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

@CapacitorPlugin(name = "Voice", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") })
public class VoicePlugin extends Plugin {

    private SpeechRecognizer recognizer;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else call.reject("需要麥克風權限才能語音輸入", "permission");
    }

    private void begin(PluginCall call) {
        String language = call.getString("language", "zh-TW");
        getActivity().runOnUiThread(() -> {
            destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new Listener());
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
            recognizer.startListening(intent);
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text.trim().isEmpty()) {
            call.reject("nothing to say");
            return;
        }
        Speaker.get(getContext()).speak(text, call.getString("language", "zh-TW"), error -> {
            JSObject result = new JSObject();
            result.put("spoken", error == null);
            if (error != null) result.put("reason", error);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        Speaker.stopIfSpeaking();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            destroy();
            notifyListeners("end", new JSObject());
            call.resolve();
        });
    }

    private void destroy() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    private static String first(Bundle results) {
        ArrayList<String> texts = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return texts == null || texts.isEmpty() ? "" : texts.get(0);
    }

    private class Listener implements RecognitionListener {

        @Override
        public void onPartialResults(Bundle partial) {
            JSObject data = new JSObject();
            data.put("text", first(partial));
            notifyListeners("partial", data);
        }

        @Override
        public void onResults(Bundle results) {
            JSObject data = new JSObject();
            data.put("text", first(results));
            notifyListeners("final", data);
            finish();
        }

        @Override
        public void onError(int error) {
            JSObject data = new JSObject();
            data.put("code", error);
            data.put("message", describe(error));
            notifyListeners("error", data);
            finish();
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            JSObject data = new JSObject();
            data.put("rms", rmsdB);
            notifyListeners("level", data);
        }

        private void finish() {
            destroy();
            notifyListeners("end", new JSObject());
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyListeners("ready", new JSObject());
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    private static String describe(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "沒有聽到內容";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "語音辨識需要網路";
            case SpeechRecognizer.ERROR_AUDIO:
                return "麥克風無法使用";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "需要麥克風權限";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "語音辨識正忙，請再試一次";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "不支援這個語言";
            default:
                return "語音辨識失敗（" + error + "）";
        }
    }
}
