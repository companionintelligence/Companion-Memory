package com.companionintelligence.localhub.location

import android.content.Context
import com.companionintelligence.localhub.OutboxStores

/**
 * The one [LocationTracker] per process. The receiver, the service and the plugin all reach
 * it through here, so a process Android spun up for a single broadcast gets a tracker wired
 * to the real platform and the shared outbox without any plugin having loaded.
 */
object LocationTracking {
    @Volatile
    private var tracker: LocationTracker? = null

    fun get(context: Context): LocationTracker {
        tracker?.let { return it }
        synchronized(this) {
            tracker?.let { return it }
            val app = context.applicationContext
            val created = LocationTracker(
                platform = AndroidLocationPlatform(app),
                store = SharedPreferencesTrackingStateStore(app),
                outbox = { OutboxStores.shared(app) },
            )
            tracker = created
            return created
        }
    }
}
