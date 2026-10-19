package com.companionintelligence.localhub

import android.content.Context

/**
 * The one [OutboxStore] per process.
 *
 * Two writers share the queue: the plugin's HTTP sidecar (the web side's enqueues) and the
 * location tracker (native enqueues from a process that may have no plugin at all, because
 * the WebView is gone). A single instance keeps [OutboxStore]'s `writeLock` meaningful across
 * both -- its check-idempotency-key-then-insert is atomic only within one instance -- and
 * avoids two SQLCipher connections to one file. The handle lives for the process; nothing
 * closes it, because every write is committed before its caller hears back and there is
 * nothing to flush.
 */
object OutboxStores {
    @Volatile
    private var instance: OutboxStore? = null

    fun shared(context: Context): OutboxStore {
        instance?.let { return it }
        synchronized(this) {
            instance?.let { return it }
            val created = OutboxStore(context.applicationContext)
            instance = created
            return created
        }
    }
}
