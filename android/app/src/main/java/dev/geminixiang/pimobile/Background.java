package dev.geminixiang.pimobile;

import com.getcapacitor.PluginCall;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class Background {
    interface Job {
        void run() throws Exception;
    }

    interface Coded {
        String code();
    }

    private static final ExecutorService SHARED = Executors.newCachedThreadPool();

    private Background() {}

    static void run(PluginCall call, Job job) {
        run(SHARED, call, job);
    }

    static void run(Executor executor, PluginCall call, Job job) {
        executor.execute(() -> {
            try {
                job.run();
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()), error instanceof Coded coded ? coded.code() : "io");
            }
        });
    }
}
