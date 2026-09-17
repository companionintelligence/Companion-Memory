package com.companionintelligence.localllm

import android.content.Context
import android.os.PowerManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

/**
 * Only the thermal governor is exercised here. Everything else on [LocalLlmEngine] —
 * `load`/`generate`/`generateStreaming` — goes through LiteRT-LM's `NativeLibraryLoader` into the
 * native libraries the AAR bundles under `jni/`, and needs a real 344 MB bundle and real CPU
 * decode, so it is device-only.
 * Constructing the engine does not touch any of that: the native library is loaded by
 * `Engine.initialize()`, not by holding a null reference to one.
 */
@RunWith(RobolectricTestRunner::class)
class LocalLlmEngineThermalTest {

    @Test
    fun the_thermal_governor_declines_at_severe_and_not_only_at_critical() {
        val context = RuntimeEnvironment.getApplication()
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val shadowPowerManager = Shadows.shadowOf(powerManager)
        val engine = LocalLlmEngine(context)

        shadowPowerManager.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_NONE)
        assertFalse(engine.isThermallyThrottled())

        // LIGHT and MODERATE are normal operating states on a phone that has been decoding for a
        // minute — refusing here would make on-device inference unusable rather than safe.
        shadowPowerManager.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_LIGHT)
        assertFalse(engine.isThermallyThrottled())
        shadowPowerManager.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_MODERATE)
        assertFalse(engine.isThermallyThrottled())

        // SEVERE is the threshold that matters: the OS is already throttling the CPU/GPU, one
        // step *before* it starts killing background work. Waiting for CRITICAL means the
        // governor only fires once the damage is done.
        shadowPowerManager.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_SEVERE)
        assertTrue(engine.isThermallyThrottled())
        shadowPowerManager.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_CRITICAL)
        assertTrue(engine.isThermallyThrottled())
    }
}
