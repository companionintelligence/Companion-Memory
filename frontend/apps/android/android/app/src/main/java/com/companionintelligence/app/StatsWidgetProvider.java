package com.companionintelligence.app;

import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;

public class StatsWidgetProvider extends MemoryWidgetProvider {
    @Override
    protected int layoutId() {
        return R.layout.widget_stats;
    }

    @Override
    protected String destination() {
        return "stats";
    }

    @Override
    protected void render(Context context, RemoteViews views, JSONObject snapshot) {
        JSONObject insight = snapshot == null ? null : snapshot.optJSONObject("insight");
        if (!WidgetSnapshotData.hasTimestamp(insight, "metricsUpdatedAt")) {
            views.setTextViewText(R.id.stats_messages, "—");
            views.setTextViewText(R.id.stats_places, "—");
            views.setTextViewText(R.id.stats_kilometers, "—");
            views.setTextViewText(R.id.stats_freshness, "Open Memory to sync activity");
            return;
        }

        views.setTextViewText(R.id.stats_messages, Integer.toString(insight.optInt("messages", 0)));
        views.setTextViewText(R.id.stats_places, Integer.toString(insight.optInt("places", 0)));
        views.setTextViewText(R.id.stats_kilometers, String.format(java.util.Locale.getDefault(), "%.1f", insight.optDouble("kilometers", 0)));
        views.setTextViewText(
                R.id.stats_freshness,
                "Updated " + WidgetSnapshotData.timeAgo(insight.optString("metricsUpdatedAt"))
        );
    }
}
