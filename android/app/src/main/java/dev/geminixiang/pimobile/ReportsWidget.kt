package dev.geminixiang.pimobile

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private const val PREFS = "pi-reports"
private const val KEY_LATEST = "latest"
private const val KEPT = 3
private val TODAY = DateTimeFormatter.ofPattern("HH:mm")
private val EARLIER = DateTimeFormatter.ofPattern("M/d HH:mm")

class ReportsWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = manager.updateAppWidget(ids, views(context))

    companion object {
        internal fun add(context: Context, report: JSONObject) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val kept = (listOf(report) + latest(context)).take(KEPT)
            prefs.edit().putString(KEY_LATEST, JSONArray(kept).toString()).apply()
            val manager = AppWidgetManager.getInstance(context)
            manager.updateAppWidget(manager.getAppWidgetIds(ComponentName(context, ReportsWidget::class.java)), views(context))
        }

        private fun latest(context: Context): List<JSONObject> =
            try {
                JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LATEST, "[]")).objects()
            } catch (error: JSONException) {
                Log.w(TRIGGERS_TAG, "dropping unreadable reports", error)
                emptyList()
            }

        private fun views(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            val reports = latest(context)
            views.setViewVisibility(R.id.reports_empty, if (reports.isEmpty()) View.VISIBLE else View.GONE)
            views.removeAllViews(R.id.reports)
            for (report in reports) views.addView(R.id.reports, row(context, report))
            return views
        }

        private fun row(context: Context, report: JSONObject): RemoteViews {
            val row = RemoteViews(context.packageName, R.layout.reports_widget_row)
            val at = Instant.ofEpochMilli(report.getLong("at")).atZone(ZoneId.systemDefault())
            val time = (if (at.toLocalDate() == LocalDate.now()) TODAY else EARLIER).format(at)
            row.setTextViewText(R.id.report_title, "${report.getString("bot")} · ${report.getString("schedule")} · $time")
            row.setTextViewText(R.id.report_text, report.getString("text"))
            AgentService.avatar(context, report.getString("avatar"))?.let { row.setImageViewIcon(R.id.report_avatar, it) }
            row.setOnClickPendingIntent(R.id.report, TriggersPlugin.openConversation(context, report.getString("conversation")))
            return row
        }
    }
}
