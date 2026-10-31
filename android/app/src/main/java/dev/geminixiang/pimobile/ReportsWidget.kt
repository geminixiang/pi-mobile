package dev.geminixiang.pimobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
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
private const val KEY_SHOWN = "shown"
private const val KEPT = 6
private const val ACTION_NEXT = "dev.geminixiang.pimobile.REPORTS_NEXT"
private const val INSET_DP = 32
private const val CHROME_DP = 98
private const val NEXT_DP = 56
private const val HEADLINE_SP = 19
private const val HEADLINE_LINE_DP = 25
private const val DETAIL_LINE_DP = 20
private val TODAY = DateTimeFormatter.ofPattern("HH:mm")
private val EARLIER = DateTimeFormatter.ofPattern("M/d HH:mm")

class ReportsWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = refresh(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = refresh(context, manager, intArrayOf(id))

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_NEXT) return super.onReceive(context, intent)
        val reports = latest(context)
        if (reports.isEmpty()) return
        val next = reports[(reports.indexOf(shown(context, reports)) + 1) % reports.size]
        prefs(context).edit().putString(KEY_SHOWN, next.getString("conversation")).apply()
        refreshAll(context)
    }

    companion object {
        internal fun add(context: Context, report: JSONObject) {
            val conversation = report.getString("conversation")
            val kept = (listOf(report) + latest(context).filter { it.getString("conversation") != conversation }).take(KEPT)
            prefs(context).edit().putString(KEY_LATEST, JSONArray(kept).toString()).putString(KEY_SHOWN, conversation).apply()
            refreshAll(context)
        }

        internal fun seen(context: Context, conversation: String) {
            val reports = latest(context)
            if (reports.none { it.getString("conversation") == conversation }) return
            prefs(context).edit().putString(KEY_LATEST, JSONArray(reports.filter { it.getString("conversation") != conversation }).toString()).apply()
            refreshAll(context)
        }

        internal fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            refresh(context, manager, manager.getAppWidgetIds(ComponentName(context, ReportsWidget::class.java)))
        }

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun latest(context: Context): List<JSONObject> =
            try {
                JSONArray(prefs(context).getString(KEY_LATEST, "[]")).objects().distinctBy { it.getString("conversation") }
            } catch (error: JSONException) {
                Log.w(TRIGGERS_TAG, "dropping unreadable reports", error)
                emptyList()
            }

        private fun shown(context: Context, reports: List<JSONObject>): JSONObject? {
            val conversation = prefs(context).getString(KEY_SHOWN, null)
            return reports.find { it.getString("conversation") == conversation } ?: reports.firstOrNull()
        }

        private fun refresh(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val reports = latest(context)
            val shown = shown(context, reports)
            for (id in ids) {
                val options = manager.getAppWidgetOptions(id)
                val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
                manager.updateAppWidget(id, if (shown == null) room(context, width, height) else report(context, shown, reports.indexOf(shown) + 1, reports.size, width, height))
            }
        }

        private fun room(context: Context, width: Int, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            views.setViewVisibility(R.id.report, View.GONE)
            views.setViewVisibility(R.id.reports_room, View.VISIBLE)
            val residents = TriggerStore.schedules(context).mapNotNull { it.avatar }.distinct()
            views.setImageViewBitmap(R.id.reports_room, BotRoom.draw(context, residents, width, height))
            views.setOnClickPendingIntent(R.id.reports_room, AgentService.openApp(context))
            return views
        }

        private fun report(context: Context, report: JSONObject, place: Int, count: Int, width: Int, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            val at = Instant.ofEpochMilli(report.getLong("at")).atZone(ZoneId.systemDefault())
            val time = (if (at.toLocalDate() == LocalDate.now()) TODAY else EARLIER).format(at)
            val headline = report.optString("headline").ifEmpty { report.getString("text") }
            val detail = if (report.optString("headline").isEmpty()) "" else report.getString("text")
            val scale = context.resources.configuration.fontScale
            val headlineLines = if (headline.length * HEADLINE_SP * scale > width - INSET_DP - (if (count > 1) NEXT_DP else 0)) 2 else 1
            val detailLines = ((height - CHROME_DP - headlineLines * HEADLINE_LINE_DP * scale) / (DETAIL_LINE_DP * scale)).toInt().coerceAtLeast(1)
            views.setViewVisibility(R.id.reports_room, View.GONE)
            views.setViewVisibility(R.id.report, View.VISIBLE)
            views.setTextViewText(R.id.report_bot, report.getString("bot"))
            views.setTextViewText(R.id.report_when, "${report.getString("schedule")} · $time")
            views.setTextViewText(R.id.report_headline, headline)
            views.setTextViewText(R.id.report_text, detail)
            views.setViewVisibility(R.id.report_text, if (detail.isEmpty()) View.GONE else View.VISIBLE)
            views.setInt(R.id.report_text, "setMaxLines", detailLines)
            AgentService.avatar(context, report.getString("avatar"))?.let { views.setImageViewIcon(R.id.report_avatar, it) }
            views.setOnClickPendingIntent(R.id.report, TriggersPlugin.openConversation(context, report.getString("conversation")))
            views.setTextViewText(R.id.report_place, "$place/$count")
            views.setContentDescription(R.id.report_next, "下一則，第 $place 則，共 $count 則")
            views.setViewVisibility(R.id.report_next, if (count == 1) View.GONE else View.VISIBLE)
            val next = Intent(context, ReportsWidget::class.java).setAction(ACTION_NEXT)
            views.setOnClickPendingIntent(R.id.report_next, PendingIntent.getBroadcast(context, 0, next, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            return views
        }
    }
}
