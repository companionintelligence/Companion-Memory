package com.companionintelligence.localllm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GenerationServiceStateTest {

    @Test
    fun a_stop_after_the_service_is_in_the_foreground_is_carried_out_by_the_caller() {
        val state = GenerationServiceState()
        state.starting()

        assertFalse("nothing pending: keep running", state.enteredForeground())
        assertTrue("the caller stops the service", state.stopRequested())
        assertFalse("and it is not stopped twice", state.stopRequested())
    }

    @Test
    fun a_stop_before_the_foreground_is_deferred_to_the_service_itself() {
        // The crash: generation over before onStartCommand ran. stopService() here would be fatal.
        val state = GenerationServiceState()
        state.starting()

        assertFalse("not in the foreground yet: the caller must NOT stopService()", state.stopRequested())
        assertTrue("…the service stops itself once it has kept its promise", state.enteredForeground())
    }

    @Test
    fun a_new_generation_cancels_a_pending_stop() {
        val state = GenerationServiceState()
        state.starting()
        assertFalse(state.stopRequested())

        // Another generation started before the service came up: it must stay up for that one.
        state.starting()
        assertFalse("keep running", state.enteredForeground())
        assertTrue("the later stop is immediate", state.stopRequested())
    }

    @Test
    fun a_service_that_ended_on_its_own_leaves_nothing_for_the_caller_to_stop() {
        val state = GenerationServiceState()
        state.starting()
        assertFalse(state.enteredForeground())

        state.ended()
        assertFalse(state.stopRequested())
    }
}
