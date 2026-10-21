package dev.geminixiang.pimobile;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Reads text aloud with the system's text-to-speech engine, for the speak tool. One engine for the process, created on
 * first use; it also works while pi is in the background, so a run started by a trigger can talk into the headphones.
 * Other audio is ducked while it speaks. stop() ends the speech at once, for example when the headphones disconnect.
 */
final class Speaker {

    interface Done {
        /** Null when everything was spoken; otherwise why not. */
        void finished(String error);
    }

    private static final String TAG = "PiSpeaker";
    private static Speaker instance;

    private final Context context;
    private final AudioManager audio;
    private final AudioFocusRequest focus;
    private TextToSpeech engine;
    /** Null until the engine answered; then whether it can speak. */
    private Boolean ready;
    private final List<Runnable> waiting = new ArrayList<>();
    private String current;
    private Done done;

    private Speaker(Context context) {
        this.context = context.getApplicationContext();
        audio = this.context.getSystemService(AudioManager.class);
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes).build();
    }

    static synchronized Speaker get(Context context) {
        if (instance == null) instance = new Speaker(context);
        return instance;
    }

    /** Stop speaking, if it is, without creating the engine. */
    static synchronized void stopIfSpeaking() {
        if (instance != null) instance.stop("stopped");
    }

    private void withEngine(Runnable action) {
        if (Boolean.TRUE.equals(ready)) {
            action.run();
            return;
        }
        waiting.add(action);
        if (engine != null) return;
        engine = new TextToSpeech(context, status -> {
            synchronized (Speaker.this) {
                ready = status == TextToSpeech.SUCCESS;
                if (ready) {
                    engine.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                    engine.setOnUtteranceProgressListener(new Progress());
                }
                List<Runnable> actions = new ArrayList<>(waiting);
                waiting.clear();
                if (!ready) {
                    engine = null;
                    ready = null;
                }
                for (Runnable queued : actions) queued.run();
            }
        });
    }

    /** Speak `text` in `language` (a BCP 47 tag such as zh-TW); `done` runs once, when it ends, fails, or is stopped. */
    synchronized void speak(String text, String language, Done done) {
        stop("replaced by newer speech");
        withEngine(() -> {
            synchronized (Speaker.this) {
                if (engine == null) {
                    done.finished("this phone has no text-to-speech engine");
                    return;
                }
                Locale locale = Locale.forLanguageTag(language);
                int support = engine.isLanguageAvailable(locale);
                if (support < TextToSpeech.LANG_AVAILABLE) {
                    done.finished("the text-to-speech engine has no voice for " + language);
                    return;
                }
                engine.setLanguage(locale);
                String id = UUID.randomUUID().toString();
                current = id;
                this.done = done;
                audio.requestAudioFocus(focus);
                List<String> parts = split(text, Math.min(TextToSpeech.getMaxSpeechInputLength(), 1000));
                for (int i = 0; i < parts.size(); i++) {
                    // Only the last part carries the id that ends the speech.
                    String utterance = i == parts.size() - 1 ? id : id + "/" + i;
                    engine.speak(parts.get(i), TextToSpeech.QUEUE_ADD, new Bundle(), utterance);
                }
            }
        });
    }

    synchronized void stop(String reason) {
        if (current == null) return;
        if (engine != null) engine.stop();
        finish(reason);
    }

    private synchronized void finish(String error) {
        Done callback = done;
        current = null;
        done = null;
        audio.abandonAudioFocusRequest(focus);
        if (callback != null) callback.finished(error);
    }

    /** Pieces no longer than `max`, cut after sentence ends where possible. */
    static List<String> split(String text, int max) {
        List<String> parts = new ArrayList<>();
        String rest = text.trim();
        while (rest.length() > max) {
            int cut = -1;
            for (int i = max; i > max / 2; i--) {
                char c = rest.charAt(i - 1);
                if ("。！？!?；;\n".indexOf(c) >= 0 || (c == '.' && i < rest.length() && rest.charAt(i) == ' ')) {
                    cut = i;
                    break;
                }
            }
            if (cut < 0) cut = max;
            parts.add(rest.substring(0, cut).trim());
            rest = rest.substring(cut).trim();
        }
        if (!rest.isEmpty()) parts.add(rest);
        return parts;
    }

    private final class Progress extends UtteranceProgressListener {
        @Override
        public void onStart(String utteranceId) {}

        @Override
        public void onDone(String utteranceId) {
            synchronized (Speaker.this) {
                if (utteranceId.equals(current)) finish(null);
            }
        }

        @Override
        @Deprecated
        public void onError(String utteranceId) {
            onError(utteranceId, TextToSpeech.ERROR);
        }

        @Override
        public void onError(String utteranceId, int errorCode) {
            synchronized (Speaker.this) {
                if (current != null && utteranceId.startsWith(current)) {
                    Log.w(TAG, "speech failed " + errorCode);
                    engine.stop();
                    finish("text-to-speech failed (" + errorCode + ")");
                }
            }
        }
    }
}
