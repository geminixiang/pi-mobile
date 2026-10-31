package dev.geminixiang.pimobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
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
private const val KEY_SELECTED = "selected"
private const val KEPT = 6
private const val ACTION_SHOW = "dev.geminixiang.pimobile.REPORTS_SHOW"
private const val EXTRA_CONVERSATION = "conversation"
private const val CHROME_DP = 100
private const val LINE_DP = 27
private val TODAY = DateTimeFormatter.ofPattern("HH:mm")
private val EARLIER = DateTimeFormatter.ofPattern("M/d HH:mm")

class ReportsWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = refresh(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = refresh(context, manager, intArrayOf(id))

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_SHOW) return super.onReceive(context, intent)
        prefs(context).edit().putString(KEY_SELECTED, intent.getStringExtra(EXTRA_CONVERSATION)).apply()
        refreshAll(context)
    }

    companion object {
        internal fun add(context: Context, report: JSONObject) {
            val conversation = report.getString("conversation")
            val kept = (listOf(report) + latest(context).filter { it.getString("conversation") != conversation }).take(KEPT)
            prefs(context).edit().putString(KEY_LATEST, JSONArray(kept).toString()).putString(KEY_SELECTED, conversation).apply()
            refreshAll(context)
        }

        internal fun seen(context: Context, conversation: String) {
            val reports = latest(context)
            if (reports.none { it.getString("conversation") == conversation }) return
            prefs(context).edit().putString(KEY_LATEST, JSONArray(reports.filter { it.getString("conversation") != conversation }).toString()).apply()
            refreshAll(context)
        }

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun latest(context: Context): List<JSONObject> =
            try {
                JSONArray(prefs(context).getString(KEY_LATEST, "[]")).objects().distinctBy { it.getString("conversation") }
            } catch (error: JSONException) {
                Log.w(TRIGGERS_TAG, "dropping unreadable reports", error)
                emptyList()
            }

        internal fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            refresh(context, manager, manager.getAppWidgetIds(ComponentName(context, ReportsWidget::class.java)))
        }

        private fun refresh(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val reports = latest(context)
            val selected = prefs(context).getString(KEY_SELECTED, null)
            val shown = reports.find { it.getString("conversation") == selected } ?: reports.firstOrNull()
            for (id in ids) {
                val options = manager.getAppWidgetOptions(id)
                val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
                manager.updateAppWidget(id, if (shown == null) room(context, width, height) else views(context, reports, shown, height))
            }
        }

        private fun room(context: Context, width: Int, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            views.setViewVisibility(R.id.reports_content, View.GONE)
            views.setViewVisibility(R.id.reports_room, View.VISIBLE)
            val residents = TriggerStore.schedules(context).mapNotNull { it.avatar }.distinct()
            views.setImageViewBitmap(R.id.reports_room, BotRoom.draw(context, residents, width, height))
            views.setOnClickPendingIntent(R.id.reports_room, AgentService.openApp(context))
            return views
        }

        private fun views(context: Context, reports: List<JSONObject>, shown: JSONObject, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            val lines = ((height - CHROME_DP) / (LINE_DP * context.resources.configuration.fontScale)).toInt().coerceAtLeast(2)
            views.removeAllViews(R.id.reports_bots)
            for (report in reports) views.addView(R.id.reports_bots, bot(context, report, report === shown))
            val at = Instant.ofEpochMilli(shown.getLong("at")).atZone(ZoneId.systemDefault())
            val time = (if (at.toLocalDate() == LocalDate.now()) TODAY else EARLIER).format(at)
            views.setTextViewText(R.id.report_title, "${shown.getString("bot")} · ${shown.getString("schedule")} · $time")
            views.setTextViewText(R.id.report_text, shown.getString("text"))
            views.setInt(R.id.report_text, "setMaxLines", lines)
            views.setOnClickPendingIntent(R.id.report, TriggersPlugin.openConversation(context, shown.getString("conversation")))
            return views
        }

        private fun bot(context: Context, report: JSONObject, selected: Boolean): RemoteViews {
            val conversation = report.getString("conversation")
            val bot = RemoteViews(context.packageName, R.layout.reports_widget_bot)
            AgentService.avatar(context, report.getString("avatar"))?.let { bot.setImageViewIcon(R.id.report_bot, it) }
            bot.setFloat(R.id.report_bot, "setAlpha", if (selected) 1f else 0.4f)
            bot.setContentDescription(R.id.report_bot, report.getString("bot"))
            val show =
                Intent(context, ReportsWidget::class.java)
                    .setAction(ACTION_SHOW)
                    .setData(Uri.parse("pimobile-report://" + Uri.encode(conversation)))
                    .putExtra(EXTRA_CONVERSATION, conversation)
            bot.setOnClickPendingIntent(R.id.report_bot, PendingIntent.getBroadcast(context, 0, show, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            return bot
        }
    }
}
