package com.companionintelligence.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

public class PlannerWidgetProvider extends MemoryWidgetProvider {
    @Override
    protected int layoutId() {
        return R.layout.widget_plan;
    }

    @Override
    protected String destination() {
        return "plan";
    }

    @Override
    protected void render(Context context, RemoteViews views, JSONObject snapshot) {
        JSONObject plan = snapshot == null ? null : snapshot.optJSONObject("plan");
        JSONArray tasks = plan == null ? new JSONArray() : plan.optJSONArray("tasks");
        if (tasks == null) tasks = new JSONArray();
        boolean hasPlanData = WidgetSnapshotData.hasTimestamp(plan, "updatedAt");
        views.setTextViewText(
                R.id.plan_open_count,
                !hasPlanData ? "—" : plan.optInt("openCount", 0) + " open"
        );
        if (!hasPlanData) {
            views.setTextViewText(R.id.plan_task_one, "Open Memory to sync your plan");
            views.setTextViewText(R.id.plan_task_two, "");
            views.setTextViewText(R.id.plan_due_one, "");
            views.setTextViewText(R.id.plan_due_two, "");
            views.setTextViewText(R.id.plan_freshness, "Open Memory to refresh");
            views.setViewVisibility(R.id.plan_done_one, View.GONE);
            views.setViewVisibility(R.id.plan_done_two, View.GONE);
            return;
        }
        renderTask(context, views, tasks.optJSONObject(0), R.id.plan_task_one, R.id.plan_due_one, R.id.plan_done_one, 0);
        renderTask(context, views, tasks.optJSONObject(1), R.id.plan_task_two, R.id.plan_due_two, R.id.plan_done_two, 1);
        views.setTextViewText(
                R.id.plan_freshness,
                "Updated " + WidgetSnapshotData.timeAgo(plan == null ? null : plan.optString("updatedAt"))
        );
    }

    private void renderTask(
            Context context,
            RemoteViews views,
            JSONObject task,
            int titleView,
            int dueView,
            int doneView,
            int index
    ) {
        if (task == null) {
            views.setTextViewText(titleView, index == 0 ? "Nothing due next" : "");
            views.setTextViewText(dueView, "");
            views.setViewVisibility(doneView, View.GONE);
            return;
        }
        String taskId = task.optString("id", "");
        String title = task.optString("title", "Untitled task");
        if (taskId.trim().isEmpty() || taskId.length() > 256) {
            views.setTextViewText(titleView, title);
            views.setTextViewText(dueView, WidgetSnapshotData.dueLabel(task.optString("dueAt")));
            views.setViewVisibility(doneView, View.GONE);
            return;
        }

        views.setTextViewText(titleView, title);
        views.setTextViewText(dueView, WidgetSnapshotData.dueLabel(task.optString("dueAt")));
        views.setViewVisibility(doneView, View.VISIBLE);
        views.setContentDescription(doneView, "Complete " + title);

        Intent action = new Intent(context, WidgetTaskActionReceiver.class)
                .setAction(WidgetSnapshotData.COMPLETE_TASK_ACTION)
                .setData(Uri.parse("companion-widget-task:" + Uri.encode(taskId)))
                .putExtra("taskId", taskId);
        PendingIntent pending = PendingIntent.getBroadcast(
                context,
                taskId.hashCode(),
                action,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(doneView, pending);
    }
}
