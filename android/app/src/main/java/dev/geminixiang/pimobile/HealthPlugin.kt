package dev.geminixiang.pimobile

import android.content.pm.PackageManager
import android.health.connect.AggregateRecordsGroupedByPeriodResponse
import android.health.connect.AggregateRecordsRequest
import android.health.connect.HealthConnectException
import android.health.connect.HealthConnectManager
import android.health.connect.LocalTimeRangeFilter
import android.health.connect.ReadRecordsRequestUsingFilters
import android.health.connect.ReadRecordsResponse
import android.health.connect.TimeInstantRangeFilter
import android.health.connect.datatypes.AggregationType
import android.health.connect.datatypes.ExerciseSessionRecord
import android.health.connect.datatypes.HeartRateRecord
import android.health.connect.datatypes.Record
import android.health.connect.datatypes.SleepSessionRecord
import android.health.connect.datatypes.StepsRecord
import android.health.connect.datatypes.WeightRecord
import android.os.OutcomeReceiver
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId

@CapacitorPlugin(
    name = "Health",
    permissions = [
        Permission(
            strings = [
                "android.permission.health.READ_STEPS",
                "android.permission.health.READ_SLEEP",
                "android.permission.health.READ_HEART_RATE",
                "android.permission.health.READ_EXERCISE",
                "android.permission.health.READ_WEIGHT",
            ],
            alias = "health",
        ),
    ],
)
class HealthPlugin : Plugin() {
    private fun manager(): HealthConnectManager? = context.getSystemService(HealthConnectManager::class.java)

    @PluginMethod
    fun read(call: PluginCall) {
        if (manager() == null) {
            call.reject("Health Connect needs Android 14 or later")
            return
        }
        if (anyGranted()) {
            run(call)
            return
        }
        if (!TriggersPlugin.inFront(activity)) {
            call.reject("pi has no health permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
            return
        }
        requestPermissionForAlias("health", call, "readResult")
    }

    private fun anyGranted() = READS.any { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    @PermissionCallback
    private fun readResult(call: PluginCall) {
        if (anyGranted()) run(call) else call.reject("health permission denied", "permission")
    }

    private fun run(call: PluginCall) {
        val manager = manager()
        if (manager == null) {
            call.reject("Health Connect needs Android 14 or later")
            return
        }
        val days = (call.getInt("days") ?: 7).coerceIn(1, 90)
        val today = LocalDate.now()
        val start = today.minusDays((days - 1).toLong()).atStartOfDay()
        val end = today.plusDays(1).atStartOfDay()
        val from = start.atZone(ZoneId.systemDefault()).toInstant()
        val to = end.atZone(ZoneId.systemDefault()).toInstant()
        when (call.getString("metric", "steps")) {
            "steps" -> perDay(call, manager, StepsRecord.STEPS_COUNT_TOTAL, start, end)
            "heart_rate" -> perDay(call, manager, HeartRateRecord.BPM_AVG, start, end)
            "sleep" -> records(call, manager, SleepSessionRecord::class.java, from, to)
            "exercise" -> records(call, manager, ExerciseSessionRecord::class.java, from, to)
            "weight" -> records(call, manager, WeightRecord::class.java, from, to)
            else -> call.reject("metric is steps, heart_rate, sleep, exercise, or weight")
        }
    }

    private fun <T : Any> perDay(
        call: PluginCall,
        manager: HealthConnectManager,
        type: AggregationType<T>,
        start: LocalDateTime,
        end: LocalDateTime,
    ) {
        val request =
            AggregateRecordsRequest
                .Builder<T>(LocalTimeRangeFilter.Builder().setStartTime(start).setEndTime(end).build())
                .addAggregationType(type)
                .build()
        manager.aggregateGroupByPeriod(
            request,
            Period.ofDays(1),
            context.mainExecutor,
            object : OutcomeReceiver<List<AggregateRecordsGroupedByPeriodResponse<T>>, HealthConnectException> {
                override fun onResult(groups: List<AggregateRecordsGroupedByPeriodResponse<T>>) {
                    val items =
                        groups.mapNotNull { group ->
                            group.get(type)?.let { value ->
                                JSObject()
                                    .put("day", group.startTime.toLocalDate().toString())
                                    .put("value", if (value is Number) value.toDouble() else 0.0)
                            }
                        }
                    call.resolve(JSObject().put("days", JSArray(items)))
                }

                override fun onError(error: HealthConnectException) = call.reject(error.message)
            },
        )
    }

    private fun <R : Record> records(
        call: PluginCall,
        manager: HealthConnectManager,
        type: Class<R>,
        from: Instant,
        to: Instant,
    ) {
        val request =
            ReadRecordsRequestUsingFilters
                .Builder(type)
                .setTimeRangeFilter(TimeInstantRangeFilter.Builder().setStartTime(from).setEndTime(to).build())
                .setPageSize(500)
                .build()
        manager.readRecords(
            request,
            context.mainExecutor,
            object : OutcomeReceiver<ReadRecordsResponse<R>, HealthConnectException> {
                override fun onResult(response: ReadRecordsResponse<R>) {
                    call.resolve(JSObject().put("records", JSArray(response.records.map { describe(it) })))
                }

                override fun onError(error: HealthConnectException) = call.reject(error.message)
            },
        )
    }

    companion object {
        private val READS =
            listOf(
                "android.permission.health.READ_STEPS",
                "android.permission.health.READ_SLEEP",
                "android.permission.health.READ_HEART_RATE",
                "android.permission.health.READ_EXERCISE",
                "android.permission.health.READ_WEIGHT",
            )

        private fun describe(record: Record): JSObject {
            val item = JSObject()
            item.put("source", record.metadata.dataOrigin.packageName)
            when (record) {
                is SleepSessionRecord -> {
                    item.put("start", record.startTime.toEpochMilli())
                    item.put("end", record.endTime.toEpochMilli())
                    val stages = JSObject()
                    record.stages.forEach { stage ->
                        val name = stageName(stage.type)
                        stages.put(name, stages.optLong(name, 0) + Duration.between(stage.startTime, stage.endTime).toMinutes())
                    }
                    if (stages.length() > 0) item.put("stageMinutes", stages)
                }
                is ExerciseSessionRecord -> {
                    item.put("start", record.startTime.toEpochMilli())
                    item.put("end", record.endTime.toEpochMilli())
                    item.put("type", record.exerciseType)
                    record.title?.let { item.put("title", it.toString()) }
                }
                is WeightRecord -> {
                    item.put("time", record.time.toEpochMilli())
                    item.put("kg", record.weight.inGrams / 1000)
                }
            }
            return item
        }

        private fun stageName(type: Int) =
            when (type) {
                SleepSessionRecord.StageType.STAGE_TYPE_AWAKE, SleepSessionRecord.StageType.STAGE_TYPE_AWAKE_IN_BED -> "awake"
                SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_LIGHT -> "light"
                SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_DEEP -> "deep"
                SleepSessionRecord.StageType.STAGE_TYPE_SLEEPING_REM -> "rem"
                else -> "asleep"
            }
    }
}
