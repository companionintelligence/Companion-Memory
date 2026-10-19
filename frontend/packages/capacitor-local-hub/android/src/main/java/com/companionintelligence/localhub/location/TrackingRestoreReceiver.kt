package com.companionintelligence.localhub.location

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The two system events that end the location service without the person asking: a reboot,
 * and an update of this app (the system force-stops the package). Neither may restart it --
 * without the background-location grant a location service started here would receive
 * nothing -- so with Always on the receiver posts the resume nudge, and the app open it asks
 * for is what restarts sampling (see [LocationTracker]).
 *
 * Both broadcasts are protected -- only the system can send them -- so the receiver is safe
 * to export, which a manifest receiver with an intent filter has to declare. An app the
 * person force-stopped from Settings is in the stopped state and receives neither broadcast
 * until its next launch; the plugin's resume hook covers that case.
 */
class TrackingRestoreReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reason = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> SamplingLossReason.REBOOT
            Intent.ACTION_MY_PACKAGE_REPLACED -> SamplingLossReason.APP_UPDATE
            else -> return
        }
        LocationTracking.get(context).onSamplingLost(reason)
    }
}
