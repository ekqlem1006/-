package io.github.ekqlem1006.planner

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.RemoteViews
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

class PlannerWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        refreshAll(context)
        RefreshWorker.schedule(context)
    }

    override fun onEnabled(context: Context) {
        RefreshWorker.schedule(context)
    }

    override fun onDisabled(context: Context) {
        RefreshWorker.cancel(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REFRESH -> refreshAll(context)
            ACTION_TOGGLE -> toggle(context, intent)
            else -> super.onReceive(context, intent)
        }
    }

    private fun toggle(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val done = intent.getBooleanExtra(EXTRA_DONE, false)
        val uid = Todos.uid() ?: return

        // 쓰기는 기기 캐시에 먼저 반영되므로 목록은 바로 다시 그린다.
        // 서버 전송이 끝날 때까지(최대 8초) 프로세스가 살아 있도록 goAsync 로 붙잡아 둔다.
        // 오프라인이면 Firestore 가 대기열에 보관했다가 다음에 앱이 깨어날 때 보낸다.
        val pending = goAsync()
        var finished = false
        val finish = Runnable {
            if (!finished) {
                finished = true
                pending.finish()
            }
        }
        val handler = Handler(Looper.getMainLooper())
        handler.postDelayed(finish, 8000)
        Todos.collection(uid).document(id).update("done", !done)
            .addOnCompleteListener { handler.post(finish) }
        refreshAll(context)
    }

    companion object {
        const val ACTION_REFRESH = "io.github.ekqlem1006.planner.REFRESH"
        const val ACTION_TOGGLE = "io.github.ekqlem1006.planner.TOGGLE"
        const val EXTRA_ID = "id"
        const val EXTRA_DONE = "done"

        fun dateLabel(): String {
            val d = LocalDate.now()
            val dow = d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.KOREAN)
            return "${d.monthValue}월 ${d.dayOfMonth}일 ($dow)"
        }

        /** 모든 플래너 위젯의 틀을 다시 그리고 목록 데이터를 새로 읽게 한다. */
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, PlannerWidget::class.java))
            if (ids.isEmpty()) return
            for (id in ids) manager.updateAppWidget(id, buildViews(context, id))
            @Suppress("DEPRECATION")
            manager.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }

        private fun buildViews(context: Context, widgetId: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget)
            val immutable = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

            views.setTextViewText(R.id.title, dateLabel())
            views.setTextViewText(
                R.id.empty,
                context.getString(if (Todos.uid() == null) R.string.widget_need_login else R.string.widget_empty)
            )

            // 제목 → 앱 열기
            views.setOnClickPendingIntent(
                R.id.title,
                PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), immutable)
            )
            // + → 할 일 추가 창 (로그인 전이면 앱으로)
            val addTarget = if (Todos.uid() == null) MainActivity::class.java else AddTodoActivity::class.java
            views.setOnClickPendingIntent(
                R.id.add,
                PendingIntent.getActivity(
                    context, 1,
                    Intent(context, addTarget).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    immutable
                )
            )
            // ⟳ → 새로고침
            views.setOnClickPendingIntent(
                R.id.refresh,
                PendingIntent.getBroadcast(
                    context, 2,
                    Intent(context, PlannerWidget::class.java).setAction(ACTION_REFRESH),
                    immutable
                )
            )

            // 목록
            val service = Intent(context, TodoListService::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            service.data = Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
            @Suppress("DEPRECATION")
            views.setRemoteAdapter(R.id.list, service)
            views.setEmptyView(R.id.list, R.id.empty)
            // 항목마다 id/done 을 채워 넣어야 해서 이 PendingIntent 만 MUTABLE
            views.setPendingIntentTemplate(
                R.id.list,
                PendingIntent.getBroadcast(
                    context, 3,
                    Intent(context, PlannerWidget::class.java).setAction(ACTION_TOGGLE),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                )
            )
            return views
        }
    }
}
