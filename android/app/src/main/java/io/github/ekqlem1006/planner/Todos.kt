package io.github.ekqlem1006.planner

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.firestore.Source
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** 웹 플래너와 같은 Firestore 경로(users/{uid}/todos)·같은 필드를 쓴다. */
object Todos {
    data class Todo(
        val id: String,
        val text: String,
        val date: String, // YYYY-MM-DD (기기 현지 날짜)
        val done: Boolean,
        val createdAt: Long,
    )

    fun today(): String = LocalDate.now().toString()

    fun uid(): String? = FirebaseAuth.getInstance().currentUser?.uid

    fun collection(uid: String): CollectionReference =
        FirebaseFirestore.getInstance().collection("users").document(uid).collection("todos")

    fun add(uid: String, text: String) =
        collection(uid).document().set(
            mapOf(
                "text" to text,
                "date" to today(),
                "done" to false,
                "createdAt" to System.currentTimeMillis(),
            )
        )

    /**
     * 위젯에 보여 줄 목록: 오늘 할 일 + 지난 날짜에 끝내지 못한 일.
     * 네트워크를 기다리므로 메인 스레드에서 부르면 안 된다. 로그인 전이면 null.
     */
    fun loadForWidget(): List<Todo>? {
        val uid = uid() ?: return null
        val today = today()
        val col = collection(uid)
        val todays = fetch(col.whereEqualTo("date", today))
        val undone = fetch(col.whereEqualTo("done", false))

        val byId = LinkedHashMap<String, Todo>()
        for (snap in listOf(todays, undone)) {
            for (d in snap?.documents ?: emptyList()) {
                byId[d.id] = Todo(
                    id = d.id,
                    text = d.getString("text") ?: "",
                    date = d.getString("date") ?: today,
                    done = d.getBoolean("done") ?: false,
                    createdAt = (d.get("createdAt") as? Number)?.toLong() ?: 0L,
                )
            }
        }
        // 오늘 남은 일 → 밀린 일 → 오늘 끝낸 일
        return byId.values
            .filter { it.date == today || (!it.done && it.date < today) }
            .sortedWith(
                compareBy<Todo> { if (it.done) 2 else if (it.date < today) 1 else 0 }
                    .thenBy { it.date }
                    .thenBy { it.createdAt }
            )
    }

    /** 서버에서 먼저 받아 보고, 느리거나 오프라인이면 기기 캐시로 대신한다. */
    private fun fetch(q: Query): QuerySnapshot? =
        try {
            Tasks.await(q.get(), 8, TimeUnit.SECONDS)
        } catch (e: Exception) {
            try {
                Tasks.await(q.get(Source.CACHE), 3, TimeUnit.SECONDS)
            } catch (e2: Exception) {
                null
            }
        }
}
