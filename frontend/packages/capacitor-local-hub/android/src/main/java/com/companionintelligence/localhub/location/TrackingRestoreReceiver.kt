package com.companionintelligence.localhub.location

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Puts the tracker's OS-side state back after the two events that wipe it without touching
 * the saved state: a reboot (Play Services drops every geofence, and the location service is
 * gone) and an update of this app (the system force-stops the package, which cancels its
 * PendingIntents, and the fence goes with them). Both broadcasts are protected -- only the
 * system can send them -- so the receiver is safe to export, which a manifest receiver with
 * an intent filter has to declare.
 *
 * Registering a fence is a round trip to Play Services, so the broadcast is held open with
 * [goAsync] until the tracker reports back; a failed registration (at boot, Play Services
 * may still be starting) is retried by [TrackingRestoreWorker]. An app the person
 * force-stopped from Settings is in the stopped state and receives neither broadcast until
 * its next launch; the plugin's resume hook covers that case.
 */
class TrackingRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        val result = goAsync()
        LocationTracking.get(context).restore { restored ->
            if (restored) {
                Log.i(TAG, "restored after $action")
            } else {
                Log.w(TAG, "could not restore after $action; scheduling a retry")
                TrackingRestoreWorker.schedule(context)
            }
            result.finish()
        }
    }

    private companion object {
        const val TAG = "LocationRestore"
    }
}
