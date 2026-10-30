package com.companionintelligence.localhub.replica

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only: runs the background replica sync once, now, so it can be tested from adb
 * without waiting for the period.
 *
 *   adb shell am broadcast -n com.ci.memory/com.companionintelligence.localhub.replica.ReplicaSyncNowReceiver \
 *       -a com.companionintelligence.localhub.debug.REPLICA_SYNC_NOW
 *   adb logcat -s ReplicaSync
 */
class ReplicaSyncNowReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ReplicaSyncWorker.runOnce(context)
    }
}
