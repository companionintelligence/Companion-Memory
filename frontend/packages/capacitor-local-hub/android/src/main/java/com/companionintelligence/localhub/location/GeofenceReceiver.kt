package com.companionintelligence.localhub.location

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * The exit geofence around the resting spot fired: the phone is on the move again. Reached
 * with no WebView, no plugin instance and no JavaScript; [LocationTracking] wires the
 * tracker to the real platform and the shared outbox from here.
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) {
            return
        }
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) {
            Log.w(TAG, "geofence event error ${event.errorCode}")
            return
        }
        if (event.geofenceTransition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            LocationTracking.get(context).onGeofenceExit()
        }
    }

    companion object {
        const val ACTION = "com.companionintelligence.localhub.location.GEOFENCE"
        private const val TAG = "LocationGeofence"
    }
}
