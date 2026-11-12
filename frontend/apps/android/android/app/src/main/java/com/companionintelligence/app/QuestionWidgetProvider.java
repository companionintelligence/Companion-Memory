package com.companionintelligence.app;

import android.content.Context;
import android.widget.RemoteViews;
import org.json.JSONObject;

public class QuestionWidgetProvider extends MemoryWidgetProvider {
    @Override
    protected int layoutId() {
        return R.layout.widget_questions;
    }

    @Override
    protected String destination() {
        return "questions";
    }

    @Override
    protected void render(Context context, RemoteViews views, JSONObject snapshot) {
        views.setTextViewText(R.id.questions_prompt, "What would you like to understand?");
        views.setTextViewText(R.id.questions_description, "Ask across your saved memories and records.");
        views.setTextViewText(R.id.questions_action, "Ask Memory");
    }
}
