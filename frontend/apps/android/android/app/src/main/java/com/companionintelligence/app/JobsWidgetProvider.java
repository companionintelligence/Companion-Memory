package com.companionintelligence.app;

import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;

public class JobsWidgetProvider extends MemoryWidgetProvider {
    @Override
    protected int layoutId() {
        return R.layout.widget_jobs;
    }

    @Override
    protected String destination() {
        return "jobs";
    }

    @Override
    protected void render(Context context, RemoteViews views, JSONObject snapshot) {
        JSONObject jobs = snapshot == null ? null : snapshot.optJSONObject("jobs");
        if (!WidgetSnapshotData.hasTimestamp(jobs, "updatedAt")) {
            views.setTextViewText(R.id.jobs_active, "—");
            views.setTextViewText(R.id.jobs_pending, "—");
            views.setTextViewText(R.id.jobs_attention, "—");
            views.setTextViewText(R.id.jobs_completed, "—");
            views.setTextViewText(R.id.jobs_freshness, "Open Memory to sync");
            return;
        }

        int active = jobs.optInt("active", 0);
        int pending = jobs.optInt("pending", 0);
        int attention = jobs.optInt("failed", 0) + jobs.optInt("deadLettered", 0);
        int completed = jobs.optInt("completed", 0);
        views.setTextViewText(R.id.jobs_active, Integer.toString(active));
        views.setTextViewText(R.id.jobs_pending, Integer.toString(pending));
        views.setTextViewText(R.id.jobs_attention, Integer.toString(attention));
        views.setTextViewText(R.id.jobs_completed, Integer.toString(completed));
        views.setTextViewText(
                R.id.jobs_freshness,
                "Updated " + WidgetSnapshotData.timeAgo(jobs.optString("updatedAt"))
        );
    }
}
