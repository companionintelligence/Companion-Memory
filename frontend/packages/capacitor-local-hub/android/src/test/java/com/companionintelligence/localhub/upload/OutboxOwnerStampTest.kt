package com.companionintelligence.localhub.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class OutboxOwnerStampTest {
    /**
     * Computed by `outboxOwnerStamp()`'s TypeScript (`@ci/common`'s `outbox.ts`). If these
     * drift, the background uploader stops matching the rows the app stamped -- nothing is
     * sent from the wrong account, but nothing is sent at all.
     */
    @Test
    fun `matches the stamps the web side computes`() {
        assertEquals(
            "https://memory.example.lan 18c1c4e1a552fb",
            OutboxOwnerStamp.of("https://memory.example.lan", "ci_live_abc123"),
        )
        assertEquals(
            "http://192.168.86.20:8080 156750bf98f9fd",
            OutboxOwnerStamp.of("http://192.168.86.20:8080", "k"),
        )
    }

    @Test
    fun `hashes UTF-16 code units the way charCodeAt does`() {
        assertEquals(
            "https://hub.ci.computer/m/é 0eda9c072179f5",
            OutboxOwnerStamp.of("https://hub.ci.computer/m/é", "ключ-🔑"),
        )
    }
}
