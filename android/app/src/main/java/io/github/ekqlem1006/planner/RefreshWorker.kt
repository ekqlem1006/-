package io.github.ekqlem1006.planner

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** 다른 기기에서 바꾼 내용과 날짜 넘어감을 반영하려고 15분마다(안드로이드 최소 주기) 위젯을 새로 그린다. */
class RefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        PlannerWidget.refreshAll(applicationContext)
        return Result.success()
    }

    companion object {
        private const val NAME = "planner-widget-refresh"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequest.Builder(RefreshWorker::class.java, 15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
