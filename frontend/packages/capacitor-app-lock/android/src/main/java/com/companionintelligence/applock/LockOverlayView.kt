package com.companionintelligence.applock

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The lock screen a locked app shows: a native view added to the window's decor view,
 * ABOVE the Capacitor WebView. The page underneath stays mounted and keeps syncing; the
 * user simply cannot see or touch it until the OS prompt passes. This is the control
 * SECURITY_ARCHITECTURE.md § 4.3 calls v2 — a React route gate is a presentation trick
 * that anything driving the router can get past, a view over the WebView is not.
 *
 * Deliberately plain widgets and no resources: the plugin ships no XML, so it cannot
 * collide with the host app's and needs nothing from it. The copy is fixed English, the
 * same as the OS prompt's own strings are not ours to translate either.
 */
class LockOverlayView(context: Context, onUnlock: () -> Unit) : FrameLayout(context) {
    private val note: TextView

    init {
        setBackgroundColor(BACKGROUND)
        // Swallow every touch so nothing reaches the WebView underneath.
        isClickable = true
        isFocusable = true
        fitsSystemWindows = true
        elevation = dp(24f)
        contentDescription = "Companion Memory is locked"

        val column =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                val pad = dp(32f).toInt()
                setPadding(pad, pad, pad, pad)
            }

        column.addView(
            TextView(context).apply {
                text = "Companion Memory"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
            },
        )
        column.addView(
            TextView(context).apply {
                text = "Locked"
                setTextColor(MUTED)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                gravity = Gravity.CENTER
                setPadding(0, dp(8f).toInt(), 0, 0)
            },
        )
        note =
            TextView(context).apply {
                setTextColor(MUTED)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                gravity = Gravity.CENTER
                setPadding(0, dp(8f).toInt(), 0, 0)
                visibility = View.GONE
            }
        column.addView(note)
        column.addView(
            Button(context).apply {
                text = "Unlock"
                isAllCaps = false
                setOnClickListener { onUnlock() }
                layoutParams =
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(28f).toInt() }
            },
        )

        addView(
            column,
            LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
    }

    /** The line under "Locked" — a queue depth, never content. Empty hides it. */
    fun setNote(text: String) {
        note.text = text
        note.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
    }

    private fun dp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    companion object {
        /** The app's dark surface, so the overlay reads as the app and not as a crash. */
        private val BACKGROUND = Color.parseColor("#0B1220")
        private val MUTED = Color.parseColor("#B6C2D1")
    }
}
