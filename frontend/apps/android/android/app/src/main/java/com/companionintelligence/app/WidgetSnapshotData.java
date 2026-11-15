package com.companionintelligence.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONObject;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class WidgetSnapshotData {
    static final String PREFERENCES = "companion_widget_data";
    static final String SNAPSHOT_KEY = "snapshot";
    static final String ACTIONS_KEY = "pendingActions";
    static final String REFRESH_ACTION = "com.companionintelligence.app.WIDGETS_UPDATE";
    static final String COMPLETE_TASK_ACTION = "com.companionintelligence.app.WIDGET_COMPLETE_TASK";
    private static final long MAX_SNAPSHOT_AGE_MS = 48L * 60 * 60 * 1000;

    private WidgetSnapshotData() {}

    static JSONObject read(Context context) {
        String encoded = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .getString(SNAPSHOT_KEY, null);
        if (encoded == null) return null;
        try {
            JSONObject snapshot = new JSONObject(encoded);
            long savedAt = parseIso(snapshot.optString("generatedAt")).getTime();
            long age = System.currentTimeMillis() - savedAt;
            if (snapshot.optInt("version", -1) != 1 || age < -5 * 60_000 || age > MAX_SNAPSHOT_AGE_MS) {
                return null;
            }
            return snapshot;
        } catch (Exception ignored) {
            return null;
        }
    }

    static PendingIntent openIntent(Context context, String destination, int requestCode) {
        Intent launch = new Intent(Intent.ACTION_VIEW, Uri.parse("companion://widget/" + destination))
                .setClass(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                context,
                requestCode,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static String timeAgo(String value) {
        if (value == null || value.trim().isEmpty()) return "unknown";
        try {
            long minutes = Math.max(0, (System.currentTimeMillis() - parseIso(value).getTime()) / 60_000);
            if (minutes < 1) return "just now";
            if (minutes < 60) return minutes + "m ago";
            if (minutes < 24 * 60) return (minutes / 60) + "h ago";
            return (minutes / (24 * 60)) + "d ago";
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    static String dueLabel(String value) {
        if (value == null || value.trim().isEmpty()) return "Unscheduled";
        try {
            Date due = parseIso(value);
            Calendar dueCalendar = Calendar.getInstance();
            dueCalendar.setTime(due);
            Calendar today = Calendar.getInstance();
            if (sameDay(dueCalendar, today)) return "Today";
            Calendar tomorrow = (Calendar) today.clone();
            tomorrow.add(Calendar.DAY_OF_YEAR, 1);
            if (sameDay(dueCalendar, tomorrow)) return "Tomorrow";
            if (due.before(new Date())) return "Overdue";
            return new SimpleDateFormat("MMM d", Locale.getDefault()).format(due);
        } catch (Exception ignored) {
            return "Scheduled";
        }
    }

    static String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    static boolean hasTimestamp(JSONObject object, String key) {
        if (object == null) return false;
        Object value = object.opt(key);
        return value instanceof String && !((String) value).trim().isEmpty();
    }

    private static Date parseIso(String value) throws ParseException {
        String[] patterns = {
                "yyyy-MM-dd'T'HH:mm:ss.SSSX",
                "yyyy-MM-dd'T'HH:mm:ssX",
                "yyyy-MM-dd"
        };
        for (String pattern : patterns) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
            format.setLenient(false);
            try {
                Date parsed = format.parse(value);
                if (parsed != null) return parsed;
            } catch (ParseException ignored) {
                // Try the next supported ISO form.
            }
        }
        throw new ParseException("Invalid ISO date", 0);
    }

    private static boolean sameDay(Calendar left, Calendar right) {
        return left.get(Calendar.ERA) == right.get(Calendar.ERA)
                && left.get(Calendar.YEAR) == right.get(Calendar.YEAR)
                && left.get(Calendar.DAY_OF_YEAR) == right.get(Calendar.DAY_OF_YEAR);
    }
}
