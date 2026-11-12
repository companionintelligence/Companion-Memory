package com.companionintelligence.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

public class WidgetTaskActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!WidgetSnapshotData.COMPLETE_TASK_ACTION.equals(intent.getAction())) return;
        String taskId = intent.getStringExtra("taskId");
        if (taskId == null || taskId.trim().isEmpty() || taskId.length() > 256) return;

        Context appContext = context.getApplicationContext();
        android.content.SharedPreferences preferences = appContext.getSharedPreferences(
                WidgetSnapshotData.PREFERENCES,
                Context.MODE_PRIVATE
        );
        JSONArray actions;
        try {
            actions = new JSONArray(preferences.getString(WidgetSnapshotData.ACTIONS_KEY, "[]"));
        } catch (Exception ignored) {
            actions = new JSONArray();
        }
        if (actions.length() < 20) {
            try {
                JSONObject action = new JSONObject();
                action.put("id", UUID.randomUUID().toString());
                action.put("type", "completeTask");
                action.put("taskId", taskId);
                action.put("createdAt", WidgetSnapshotData.isoNow());
                actions.put(action);
            } catch (org.json.JSONException ignored) {
                return;
            }
            preferences.edit().putString(WidgetSnapshotData.ACTIONS_KEY, actions.toString()).apply();
        }

        appContext.startActivity(new Intent(
                Intent.ACTION_VIEW,
                Uri.parse("companion://widget/plan")
        ).setClass(appContext, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
    }
}
