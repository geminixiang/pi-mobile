package dev.geminixiang.pimobile;

import android.content.Context;
import android.health.connect.AggregateRecordsGroupedByPeriodResponse;
import android.health.connect.AggregateRecordsRequest;
import android.health.connect.HealthConnectException;
import android.health.connect.HealthConnectManager;
import android.health.connect.ReadRecordsRequestUsingFilters;
import android.health.connect.ReadRecordsResponse;
import android.health.connect.TimeInstantRangeFilter;
import android.health.connect.LocalTimeRangeFilter;
import android.health.connect.datatypes.ExerciseSessionRecord;
import android.health.connect.datatypes.HeartRateRecord;
import android.health.connect.datatypes.SleepSessionRecord;
import android.health.connect.datatypes.StepsRecord;
import android.health.connect.datatypes.WeightRecord;
import android.os.OutcomeReceiver;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.Period;
import java.time.ZoneId;
import java.util.concurrent.Executor;

@CapacitorPlugin(
    name = "Health",
    permissions = {
        @Permission(
            strings = {
                "android.permission.health.READ_STEPS",
                "android.permission.health.READ_SLEEP",
                "android.permission.health.READ_HEART_RATE",
                "android.permission.health.READ_EXERCISE",
                "android.permission.health.READ_WEIGHT",
            },
            alias = "health"
        ),
    }
)
public class HealthPlugin extends Plugin {

    private HealthConnectManager manager() {
        return getContext().getSystemService(HealthConnectManager.class);
    }

    private Executor executor() {
        return getContext().getMainExecutor();
    }

    @PluginMethod
    public void read(PluginCall call) {
        if (manager() == null) {
            call.reject("Health Connect needs Android 14 or later");
            return;
        }
        if (getPermissionState("health") == PermissionState.GRANTED || anyGranted()) {
            run(call);
            return;
        }
        if (!TriggersPlugin.inFront(getActivity())) {
            call.reject("pi has no health permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.");
            return;
        }
        requestPermissionForAlias("health", call, "readResult");
    }

    private boolean anyGranted() {
        for (String permission : new String[] { "android.permission.health.READ_STEPS", "android.permission.health.READ_SLEEP", "android.permission.health.READ_HEART_RATE", "android.permission.health.READ_EXERCISE", "android.permission.health.READ_WEIGHT" }) {
            if (getContext().checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) return true;
        }
        return false;
    }

    @PermissionCallback
    private void readResult(PluginCall call) {
        if (anyGranted()) run(call);
        else call.reject("health permission denied", "permission");
    }

    private void run(PluginCall call) {
        String metric = call.getString("metric", "steps");
        int days = Math.max(1, Math.min(90, call.getInt("days", 7)));
        LocalDate today = LocalDate.now();
        LocalDateTime start = today.minusDays(days - 1).atStartOfDay();
        LocalDateTime end = today.plusDays(1).atStartOfDay();
        Instant from = start.atZone(ZoneId.systemDefault()).toInstant();
        Instant to = end.atZone(ZoneId.systemDefault()).toInstant();
        switch (metric) {
            case "steps":
                perDay(call, StepsRecord.STEPS_COUNT_TOTAL, start, end);
                break;
            case "heart_rate":
                perDay(call, HeartRateRecord.BPM_AVG, start, end);
                break;
            case "sleep":
                records(call, SleepSessionRecord.class, from, to);
                break;
            case "exercise":
                records(call, ExerciseSessionRecord.class, from, to);
                break;
            case "weight":
                records(call, WeightRecord.class, from, to);
                break;
            default:
                call.reject("metric is steps, heart_rate, sleep, exercise, or weight");
        }
    }

    private <T> void perDay(PluginCall call, android.health.connect.datatypes.AggregationType<T> type, LocalDateTime start, LocalDateTime end) {
        AggregateRecordsRequest<T> request = new AggregateRecordsRequest.Builder<T>(new LocalTimeRangeFilter.Builder().setStartTime(start).setEndTime(end).build())
            .addAggregationType(type)
            .build();
        manager().aggregateGroupByPeriod(request, Period.ofDays(1), executor(), new OutcomeReceiver<java.util.List<AggregateRecordsGroupedByPeriodResponse<T>>, HealthConnectException>() {
            @Override
            public void onResult(java.util.List<AggregateRecordsGroupedByPeriodResponse<T>> groups) {
                JSArray items = new JSArray();
                for (AggregateRecordsGroupedByPeriodResponse<T> group : groups) {
                    T value = group.get(type);
                    if (value == null) continue;
                    JSObject item = new JSObject();
                    item.put("day", group.getStartTime().toLocalDate().toString());
                    item.put("value", value instanceof Number ? ((Number) value).doubleValue() : 0);
                    items.put(item);
                }
                JSObject result = new JSObject();
                result.put("days", items);
                call.resolve(result);
            }

            @Override
            public void onError(HealthConnectException error) {
                call.reject(error.getMessage());
            }
        });
    }

    private <R extends android.health.connect.datatypes.Record> void records(PluginCall call, Class<R> type, Instant from, Instant to) {
        ReadRecordsRequestUsingFilters<R> request = new ReadRecordsRequestUsingFilters.Builder<>(type)
            .setTimeRangeFilter(new TimeInstantRangeFilter.Builder().setStartTime(from).setEndTime(to).build())
            .setPageSize(500)
            .build();
        manager().readRecords(request, executor(), new OutcomeReceiver<ReadRecordsResponse<R>, HealthConnectException>() {
            @Override
            public void onResult(ReadRecordsResponse<R> response) {
                JSArray items = new JSArray();
                for (R record : response.getRecords()) items.put(describe(getContext(), record));
                JSObject result = new JSObject();
                result.put("records", items);
                call.resolve(result);
            }

            @Override
            public void onError(HealthConnectException error) {
                call.reject(error.getMessage());
            }
        });
    }

    private static JSObject describe(Context context, android.health.connect.datatypes.Record record) {
        JSObject item = new JSObject();
        item.put("source", record.getMetadata().getDataOrigin().getPackageName());
        if (record instanceof SleepSessionRecord) {
            SleepSessionRecord sleep = (SleepSessionRecord) record;
            item.put("start", sleep.getStartTime().toEpochMilli());
            item.put("end", sleep.getEndTime().toEpochMilli());
            JSObject stages = new JSObject();
            for (SleepSessionRecord.Stage stage : sleep.getStages()) {
                String name = stageName(stage.getType());
                long minutes = java.time.Duration.between(stage.getStartTime(), stage.getEndTime()).toMinutes();
                stages.put(name, stages.optLong(name, 0) + minutes);
            }
            if (stages.length() > 0) item.put("stageMinutes", stages);
        } else if (record instanceof ExerciseSessionRecord) {
            ExerciseSessionRecord exercise = (ExerciseSessionRecord) record;
            item.put("start", exercise.getStartTime().toEpochMilli());
            item.put("end", exercise.getEndTime().toEpochMilli());
            item.put("type", exercise.getExerciseType());
            if (exercise.getTitle() != null) item.put("title", exercise.getTitle().toString());
        } else if (record instanceof WeightRecord) {
            WeightRecord weight = (WeightRecord) record;
            item.put("time", weight.getTime().toEpochMilli());
            item.put("kg", weight.getWeight().getInGrams() / 1000);
        }
        return item;
    }

    private static String stageName(int type) {
        switch (type) {
            case SleepSessionRecord.StageType.STAGE_TYPE_AWAKE:
            case SleepSessionRecord.StageType.STAGE_TYPE_AWAKE_IN_BED:
                return "awake";
            case SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_LIGHT:
                return "light";
            case SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_DEEP:
                return "deep";
            case SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_REM:
                return "rem";
            default:
                return "asleep";
        }
    }
}
