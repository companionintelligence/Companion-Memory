package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAppWidgetManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class MemoryWidgetsTest {
    private static final String PREFS = "companion_widget_data";
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
    }

    @After
    public void clearWidgetData() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void planner_widget_renders_real_tasks_and_quick_complete_controls() throws Exception {
        storeSnapshot(snapshot());
        WidgetView widget = render(PlannerWidgetProvider.class, R.layout.widget_plan);

        assertEquals("2 open", text(widget, R.id.plan_open_count));
        assertEquals("Review the release plan", text(widget, R.id.plan_task_one));
        assertEquals("Today", text(widget, R.id.plan_due_one));
        assertEquals(View.VISIBLE, widget.view.findViewById(R.id.plan_done_one).getVisibility());
        assertTrue(widget.view.findViewById(R.id.plan_done_one).isClickable());
    }

    @Test
    public void insight_widget_renders_forecast_confidence_and_activity_counts() throws Exception {
        storeSnapshot(snapshot());
        WidgetView widget = render(InsightWidgetProvider.class, R.layout.widget_insight);

        assertEquals("Planning", text(widget, R.id.insight_prediction));
        assertEquals("84% likely", text(widget, R.id.insight_confidence));
        assertEquals("5 messages  ·  2 places  ·  3.4 km", text(widget, R.id.insight_metrics));
        assertTrue(text(widget, R.id.insight_freshness).startsWith("Forecast updated "));
    }

    @Test
    public void jobs_widget_is_read_only_and_surfaces_failed_and_dead_lettered_count() throws Exception {
        storeSnapshot(snapshot());
        WidgetView widget = render(JobsWidgetProvider.class, R.layout.widget_jobs);

        assertEquals("3", text(widget, R.id.jobs_active));
        assertEquals("12", text(widget, R.id.jobs_pending));
        assertEquals("2", text(widget, R.id.jobs_attention));
        assertEquals("42", text(widget, R.id.jobs_completed));
        assertTrue(text(widget, R.id.jobs_freshness).startsWith("Updated "));
    }

    @Test
    public void missing_snapshot_shows_sync_state_instead_of_user_data_or_fake_metrics() {
        WidgetView plan = render(PlannerWidgetProvider.class, R.layout.widget_plan);
        WidgetView insight = render(InsightWidgetProvider.class, R.layout.widget_insight);
        WidgetView jobs = render(JobsWidgetProvider.class, R.layout.widget_jobs);

        assertEquals("Open Memory to sync your plan", text(plan, R.id.plan_task_one));
        assertEquals("—", text(plan, R.id.plan_open_count));
        assertEquals("", text(plan, R.id.plan_due_one));
        assertEquals("", text(plan, R.id.plan_due_two));
        assertEquals(View.GONE, plan.view.findViewById(R.id.plan_done_one).getVisibility());
        assertEquals("Open Memory to sync", text(insight, R.id.insight_prediction));
        assertEquals("Open Memory to sync", text(jobs, R.id.jobs_freshness));
        assertEquals("—", text(jobs, R.id.jobs_active));
        assertEquals("—", text(jobs, R.id.jobs_attention));
    }

    @Test
    public void partial_snapshot_does_not_claim_missing_sections_are_zero() throws Exception {
        JSONObject partial = snapshot();
        partial.getJSONObject("plan").put("updatedAt", JSONObject.NULL);
        partial.getJSONObject("insight").put("metricsUpdatedAt", JSONObject.NULL);
        partial.getJSONObject("jobs").put("updatedAt", JSONObject.NULL);
        storeSnapshot(partial);

        WidgetView plan = render(PlannerWidgetProvider.class, R.layout.widget_plan);
        WidgetView insight = render(InsightWidgetProvider.class, R.layout.widget_insight);
        WidgetView jobs = render(JobsWidgetProvider.class, R.layout.widget_jobs);

        assertEquals("—", text(plan, R.id.plan_open_count));
        assertEquals("Open Memory to sync your plan", text(plan, R.id.plan_task_one));
        assertEquals("Activity stats syncing", text(insight, R.id.insight_metrics));
        assertEquals("Forecast updated just now", text(insight, R.id.insight_freshness));
        assertEquals("—", text(jobs, R.id.jobs_active));
        assertEquals("Open Memory to sync", text(jobs, R.id.jobs_freshness));
    }

    @Test
    public void quick_complete_queues_an_idempotent_action_and_opens_the_plan() throws Exception {
        Intent action = new Intent(WidgetSnapshotData.COMPLETE_TASK_ACTION)
                .putExtra("taskId", "task-42");
        new WidgetTaskActionReceiver().onReceive(context, action);

        JSONArray queued = new JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(WidgetSnapshotData.ACTIONS_KEY, "[]"));
        assertEquals(1, queued.length());
        JSONObject queuedAction = queued.getJSONObject(0);
        assertEquals("completeTask", queuedAction.getString("type"));
        assertEquals("task-42", queuedAction.getString("taskId"));
        assertFalse(queuedAction.getString("id").trim().isEmpty());
        Intent opened = Shadows.shadowOf((android.app.Application) context).getNextStartedActivity();
        assertNotNull(opened);
        assertEquals("companion://widget/plan", opened.getData().toString());
    }

    private WidgetView render(Class<? extends android.appwidget.AppWidgetProvider> provider, int layout) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ShadowAppWidgetManager shadow = Shadows.shadowOf(manager);
        int widgetId = shadow.createWidget(provider, layout);
        android.appwidget.AppWidgetProvider instance;
        try {
            instance = provider.getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
        instance.onUpdate(context, manager, new int[] { widgetId });
        View view = shadow.getViewFor(widgetId);
        assertNotNull(view);
        return new WidgetView(widgetId, view);
    }

    private void storeSnapshot(JSONObject snapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("snapshot", snapshot.toString())
                .commit();
    }

    private JSONObject snapshot() throws Exception {
        String now = WidgetSnapshotData.isoNow();
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        JSONObject task = new JSONObject()
                .put("id", "task-1")
                .put("title", "Review the release plan")
                .put("dueAt", today);
        return new JSONObject()
                .put("version", 1)
                .put("generatedAt", now)
                .put("plan", new JSONObject()
                        .put("openCount", 2)
                        .put("updatedAt", now)
                        .put("tasks", new JSONArray().put(task)))
                .put("insight", new JSONObject()
                        .put("systemStatus", "READY")
                        .put("stillLearning", false)
                        .put("prediction", "Planning")
                        .put("confidence", 0.84)
                        .put("forecastGeneratedAt", now)
                        .put("metricsUpdatedAt", now)
                        .put("messages", 5)
                        .put("places", 2)
                        .put("kilometers", 3.4))
                .put("jobs", new JSONObject()
                        .put("pending", 12)
                        .put("active", 3)
                        .put("failed", 1)
                        .put("deadLettered", 1)
                        .put("completed", 42)
                        .put("updatedAt", now));
    }

    private static String text(WidgetView widget, int id) {
        return ((TextView) widget.view.findViewById(id)).getText().toString();
    }

    private static final class WidgetView {
        final int widgetId;
        final View view;

        WidgetView(int widgetId, View view) {
            this.widgetId = widgetId;
            this.view = view;
        }
    }
}
