package com.companionintelligence.localhub.location

import android.content.Context
import androidx.annotation.DrawableRes

/**
 * The small icon for this module's notifications.
 *
 * Android tints a notification's small icon as a stencil (alpha only), so it has to be a
 * single-colour glyph: the host app's `ic_stat_memory` drawable, the monochrome Memory
 * mark (see the Android README, "App icon"). It is the app's brand, not this plugin's, so
 * it is looked up by name in the host's resources rather than shipped here -- the other
 * plugin's notifications use the same drawable the same way -- and the launcher icon
 * stands in when a host ships none.
 */
object NotificationIcons {
    const val STATUS_ICON_NAME = "ic_stat_memory"

    @DrawableRes
    fun small(context: Context): Int {
        val app = context.applicationContext
        val id = app.resources.getIdentifier(STATUS_ICON_NAME, "drawable", app.packageName)

        return if (id != 0) id else app.applicationInfo.icon
    }
}
