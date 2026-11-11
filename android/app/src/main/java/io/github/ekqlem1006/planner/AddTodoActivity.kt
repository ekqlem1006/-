package io.github.ekqlem1006.planner

import android.app.Activity
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText

/** 위젯의 + 버튼으로 뜨는 작은 입력 창. 오늘 날짜로 할 일을 추가한다. */
class AddTodoActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_add)

        val input = findViewById<EditText>(R.id.input)
        val submit = {
            val text = input.text.toString().trim()
            val uid = Todos.uid()
            if (text.isNotEmpty() && uid != null) {
                // 서버 응답은 기다리지 않는다 — 기기 캐시에 바로 들어가고 연결되면 전송된다
                Todos.add(uid, text)
                PlannerWidget.refreshAll(this)
            }
            finish()
        }
        findViewById<Button>(R.id.ok).setOnClickListener { submit() }
        findViewById<Button>(R.id.cancel).setOnClickListener { finish() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else false
        }
        input.requestFocus()
    }
}
