package io.github.ekqlem1006.planner

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.widget.RemoteViews
import android.widget.RemoteViewsService

class TodoListService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Factory(private val context: Context) : RemoteViewsFactory {
        private var items: List<Todos.Todo> = emptyList()
        private var today: String = Todos.today()

        override fun onCreate() {}
        override fun onDestroy() {}

        // 바인더 스레드에서 불리므로 여기서 네트워크를 기다려도 된다
        override fun onDataSetChanged() {
            today = Todos.today()
            val loaded = Todos.loadForWidget()
            items = loaded ?: emptyList()

            // 제목 옆에 남은 개수 표시
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, PlannerWidget::class.java))
            val header = RemoteViews(context.packageName, R.layout.widget)
            val remaining = items.count { !it.done }
            header.setTextViewText(
                R.id.title,
                if (loaded == null || items.isEmpty()) PlannerWidget.dateLabel()
                else "${PlannerWidget.dateLabel()} · 남은 일 $remaining"
            )
            header.setTextViewText(
                R.id.empty,
                context.getString(if (loaded == null) R.string.widget_need_login else R.string.widget_empty)
            )
            for (id in ids) manager.partiallyUpdateAppWidget(id, header)
        }

        override fun getCount(): Int = items.size

        override fun getViewAt(position: Int): RemoteViews? {
            val t = items.getOrNull(position) ?: return null
            val row = RemoteViews(context.packageName, R.layout.widget_item)
            row.setTextViewText(R.id.check, if (t.done) "☑" else "☐")
            row.setTextViewText(R.id.text, t.text)
            row.setInt(
                R.id.text, "setPaintFlags",
                Paint.ANTI_ALIAS_FLAG or (if (t.done) Paint.STRIKE_THRU_TEXT_FLAG else 0)
            )
            val color = context.getColor(if (t.done) R.color.widget_text_dim else R.color.widget_text)
            row.setTextColor(R.id.text, color)
            row.setTextColor(R.id.check, context.getColor(if (t.done) R.color.widget_text_dim else R.color.accent))
            // 밀린 일은 원래 날짜를 옆에 붙여 준다
            row.setTextViewText(
                R.id.due,
                if (t.date < today) "${t.date.substring(5, 7).toInt()}/${t.date.substring(8, 10).toInt()}" else ""
            )
            row.setOnClickFillInIntent(
                R.id.item_root,
                Intent()
                    .putExtra(PlannerWidget.EXTRA_ID, t.id)
                    .putExtra(PlannerWidget.EXTRA_DONE, t.done)
            )
            return row
        }

        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount(): Int = 1
        override fun getItemId(position: Int): Long =
            items.getOrNull(position)?.id?.hashCode()?.toLong() ?: position.toLong()
        override fun hasStableIds(): Boolean = true
    }
}
