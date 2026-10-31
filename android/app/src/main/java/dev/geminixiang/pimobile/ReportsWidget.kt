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
private const val KEPT = 6
private const val CARD_INSET_DP = 48
private const val CARD_CHROME_DP = 150
private const val HEADLINE_SP = 19
private const val HEADLINE_LINE_DP = 25
private const val DETAIL_LINE_DP = 20
private val TODAY = DateTimeFormatter.ofPattern("HH:mm")
private val EARLIER = DateTimeFormatter.ofPattern("M/d HH:mm")

class ReportsWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = refresh(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = refresh(context, manager, intArrayOf(id))

    companion object {
        internal fun add(context: Context, report: JSONObject) {
            val conversation = report.getString("conversation")
            val kept = (listOf(report) + latest(context).filter { it.getString("conversation") != conversation }).take(KEPT)
            prefs(context).edit().putString(KEY_LATEST, JSONArray(kept).toString()).apply()
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

        private fun refresh(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val reports = latest(context)
            for (id in ids) {
                val options = manager.getAppWidgetOptions(id)
                val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
                manager.updateAppWidget(id, if (reports.isEmpty()) room(context, width, height) else stack(context, reports, width, height))
            }
        }

        private fun room(context: Context, width: Int, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            views.setViewVisibility(R.id.reports_stack, View.GONE)
            views.setViewVisibility(R.id.reports_room, View.VISIBLE)
            val residents = TriggerStore.schedules(context).mapNotNull { it.avatar }.distinct()
            views.setImageViewBitmap(R.id.reports_room, BotRoom.draw(context, residents, width, height))
            views.setOnClickPendingIntent(R.id.reports_room, AgentService.openApp(context))
            return views
        }

        private fun stack(context: Context, reports: List<JSONObject>, width: Int, height: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.reports_widget)
            val cards = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(1)
            reports.forEachIndexed { index, report ->
                cards.addItem(report.getString("conversation").hashCode().toLong(), card(context, report, "${index + 1}/${reports.size}", width, height))
            }
            views.setRemoteAdapter(R.id.reports_stack, cards.build())
            val open = Intent(Intent.ACTION_VIEW, null, context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            views.setPendingIntentTemplate(R.id.reports_stack, PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            return views
        }

        private fun card(context: Context, report: JSONObject, index: String, width: Int, height: Int): RemoteViews {
            val card = RemoteViews(context.packageName, R.layout.reports_widget_card)
            val at = Instant.ofEpochMilli(report.getLong("at")).atZone(ZoneId.systemDefault())
            val time = (if (at.toLocalDate() == LocalDate.now()) TODAY else EARLIER).format(at)
            val headline = report.optString("headline").ifEmpty { report.getString("text") }
            val detail = if (report.optString("headline").isEmpty()) "" else report.getString("text")
            val scale = context.resources.configuration.fontScale
            val headlineLines = if (headline.length * HEADLINE_SP * scale > width - CARD_INSET_DP) 2 else 1
            val detailLines = ((height - CARD_CHROME_DP - headlineLines * HEADLINE_LINE_DP * scale) / (DETAIL_LINE_DP * scale)).toInt().coerceAtLeast(1)
            card.setTextViewText(R.id.report_bot, report.getString("bot"))
            card.setTextViewText(R.id.report_when, "${report.getString("schedule")} · $time")
            card.setTextViewText(R.id.report_index, index)
            card.setTextViewText(R.id.report_headline, headline)
            card.setTextViewText(R.id.report_text, detail)
            card.setViewVisibility(R.id.report_text, if (detail.isEmpty()) View.GONE else View.VISIBLE)
            card.setInt(R.id.report_text, "setMaxLines", detailLines)
            AgentService.avatar(context, report.getString("avatar"))?.let { card.setImageViewIcon(R.id.report_avatar, it) }
            val conversation = Uri.parse("pimobile://open?conversation=" + Uri.encode(report.getString("conversation")))
            card.setOnClickFillInIntent(R.id.report, Intent().setData(conversation))
            return card
        }
    }
}
