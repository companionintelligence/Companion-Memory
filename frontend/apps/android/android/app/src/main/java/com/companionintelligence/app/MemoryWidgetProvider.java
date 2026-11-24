package com.companionintelligence.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import org.json.JSONObject;

abstract class MemoryWidgetProvider extends AppWidgetProvider {
    protected abstract int layoutId();
    protected abstract String destination();
    protected abstract void render(Context context, RemoteViews views, JSONObject snapshot);

    @Override
    public void onReceive(Context context, Intent intent) {
        if (WidgetSnapshotData.REFRESH_ACTION.equals(intent.getAction())) {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, getClass()));
            onUpdate(context, manager, widgetIds);
        } else {
            super.onReceive(context, intent);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), layoutId());
            views.setOnClickPendingIntent(
                    R.id.widget_root,
                    WidgetSnapshotData.openIntent(context, destination(), widgetId)
            );
            render(context, views, WidgetSnapshotData.read(context));
            manager.updateAppWidget(widgetId, views);
        }
    }
}
