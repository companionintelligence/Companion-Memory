package com.companionintelligence.app;

import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;
import java.util.Locale;

public class InsightWidgetProvider extends MemoryWidgetProvider {
    @Override
    protected int layoutId() {
        return R.layout.widget_insight;
    }

    @Override
    protected String destination() {
        return "ask";
    }

    @Override
    protected void render(Context context, RemoteViews views, JSONObject snapshot) {
        JSONObject insight = snapshot == null ? null : snapshot.optJSONObject("insight");
        if (snapshot == null) {
            views.setTextViewText(R.id.insight_prediction, "Open Memory to sync");
            views.setTextViewText(R.id.insight_confidence, "Forecast and activity will appear here");
            views.setTextViewText(R.id.insight_metrics, "Ask Memory");
            views.setTextViewText(R.id.insight_freshness, "Waiting for first sync");
            return;
        }

        String prediction = insight == null ? "" : insight.optString("prediction", "");
        double confidence = insight == null ? Double.NaN : insight.optDouble("confidence", Double.NaN);
        String confidenceText = !Double.isNaN(confidence) && !Double.isInfinite(confidence)
                ? ((int) (Math.max(0, Math.min(1, confidence)) * 100)) + "% likely"
                : "Forecast warming up";
        if (insight != null && insight.optBoolean("stillLearning")) {
            confidenceText += " · still learning";
        }
        String metrics;
        if (!WidgetSnapshotData.hasTimestamp(insight, "metricsUpdatedAt")) {
            metrics = "Activity stats syncing";
        } else {
            int messages = insight.optInt("messages", 0);
            int places = insight.optInt("places", 0);
            double kilometers = insight.optDouble("kilometers", 0);
            metrics = messages + " messages  ·  " + places + " places  ·  " +
                    String.format(Locale.getDefault(), "%.1f", kilometers) + " km";
        }

        views.setTextViewText(R.id.insight_prediction, prediction.trim().isEmpty() ? "No forecast yet" : prediction);
        views.setTextViewText(R.id.insight_confidence, confidenceText);
        views.setTextViewText(R.id.insight_metrics, metrics);
        String forecastUpdatedAt = insight == null ? null : insight.optString("forecastGeneratedAt");
        views.setTextViewText(
                R.id.insight_freshness,
                WidgetSnapshotData.hasTimestamp(insight, "forecastGeneratedAt")
                        ? "Forecast updated " + WidgetSnapshotData.timeAgo(forecastUpdatedAt)
                        : "Waiting for forecast"
        );
    }
}
