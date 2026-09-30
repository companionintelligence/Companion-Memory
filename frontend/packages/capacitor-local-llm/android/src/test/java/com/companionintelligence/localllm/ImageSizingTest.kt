package com.companionintelligence.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure geometry behind [ImagePreparer]; the `Bitmap` work itself is exercised in [ImagePreparerTest]. */
class ImageSizingTest {

    @Test
    fun the_longest_side_is_capped_at_1024_keeping_the_aspect_ratio() {
        assertEquals(ImageSizing.Size(1024, 768), ImageSizing.targetSize(4000, 3000))
        assertEquals(ImageSizing.Size(768, 1024), ImageSizing.targetSize(3000, 4000))
        assertEquals(ImageSizing.Size(1024, 1024), ImageSizing.targetSize(2048, 2048))
        assertEquals(ImageSizing.Size(1024, 576), ImageSizing.targetSize(1920, 1080))
        assertEquals(ImageSizing.Size(1024, 683), ImageSizing.targetSize(3000, 2000))
    }

    @Test
    fun an_image_already_within_the_cap_is_left_alone_and_never_upscaled() {
        assertEquals(ImageSizing.Size(1024, 1024), ImageSizing.targetSize(1024, 1024))
        assertEquals(ImageSizing.Size(1024, 500), ImageSizing.targetSize(1024, 500))
        assertEquals(ImageSizing.Size(640, 480), ImageSizing.targetSize(640, 480))
        assertEquals(ImageSizing.Size(1, 1), ImageSizing.targetSize(1, 1))
    }

    @Test
    fun a_very_thin_image_keeps_at_least_one_pixel_on_its_short_side() {
        // 10000 x 10 scales to 1024 x 1.02 — it must not collapse to a zero-height bitmap.
        assertEquals(ImageSizing.Size(1024, 1), ImageSizing.targetSize(10_000, 10))
        assertEquals(ImageSizing.Size(1, 1024), ImageSizing.targetSize(10, 10_000))
        assertEquals(ImageSizing.Size(1024, 1), ImageSizing.targetSize(1025, 1))
    }

    @Test
    fun an_image_with_no_pixels_is_an_error_not_a_zero_size() {
        for ((w, h) in listOf(0 to 100, 100 to 0, -5 to 10, 0 to 0)) {
            try {
                ImageSizing.targetSize(w, h)
                throw AssertionError("expected $w x $h to be rejected")
            } catch (expected: IllegalArgumentException) {
                // ok
            }
        }
    }

    @Test
    fun the_target_never_exceeds_the_cap_on_either_side_for_any_input() {
        for (w in listOf(1, 7, 100, 1023, 1024, 1025, 2047, 4000, 12_000, 65_000)) {
            for (h in listOf(1, 9, 99, 1024, 1500, 3000, 9_000)) {
                val size = ImageSizing.targetSize(w, h)
                assertTrue("$w x $h -> $size", size.width in 1..maxOf(w, ImageSizing.MAX_LONGEST_SIDE) && size.height >= 1)
                assertTrue("$w x $h -> $size", maxOf(size.width, size.height) <= maxOf(ImageSizing.MAX_LONGEST_SIDE, 1))
                assertTrue("never upscales: $w x $h -> $size", size.width <= w && size.height <= h)
            }
        }
    }

    @Test
    fun the_decode_sample_size_is_the_largest_power_of_two_that_keeps_the_cap_reachable() {
        assertEquals(1, ImageSizing.sampleSize(640, 480))
        assertEquals(1, ImageSizing.sampleSize(1024, 1024))
        assertEquals(1, ImageSizing.sampleSize(2047, 1000)) // 2047 / 2 = 1023 < 1024
        assertEquals(2, ImageSizing.sampleSize(2048, 1000)) // 2048 / 2 = 1024, not below the cap
        assertEquals(2, ImageSizing.sampleSize(4000, 3000))
        assertEquals(4, ImageSizing.sampleSize(4096, 3072))
        assertEquals(8, ImageSizing.sampleSize(12_000, 9_000))
    }

    @Test
    fun sampling_never_decodes_below_the_cap_and_is_always_a_power_of_two() {
        for (longest in listOf(1, 500, 1023, 1024, 1025, 2047, 2048, 3999, 4096, 8191, 8192, 50_000)) {
            val sample = ImageSizing.sampleSize(longest, longest / 2 + 1)
            assertTrue("$longest -> $sample is not a power of two", sample > 0 && (sample and (sample - 1)) == 0)
            if (longest >= ImageSizing.MAX_LONGEST_SIDE) {
                assertTrue(
                    "$longest sampled by $sample decodes to ${longest / sample}, below the cap",
                    longest / sample >= ImageSizing.MAX_LONGEST_SIDE,
                )
                // And it is the *largest* such power of two: one more halving would drop below the cap.
                assertTrue("$longest -> $sample could have sampled harder", longest / (sample * 2) < ImageSizing.MAX_LONGEST_SIDE)
            } else {
                assertEquals(1, sample)
            }
        }
    }

    @Test
    fun exif_orientations_map_to_the_transform_that_turns_the_pixels_upright() {
        // 1 = as stored. The phone-camera portrait case is 6 (rotate 90 clockwise) — 8 is its inverse.
        assertTrue(ImageSizing.orientationFix(1).isIdentity)
        assertEquals(ImageSizing.OrientationFix(90, false), ImageSizing.orientationFix(6))
        assertEquals(ImageSizing.OrientationFix(270, false), ImageSizing.orientationFix(8))
        assertEquals(ImageSizing.OrientationFix(180, false), ImageSizing.orientationFix(3))
        assertEquals(ImageSizing.OrientationFix(0, true), ImageSizing.orientationFix(2))
        assertEquals(ImageSizing.OrientationFix(180, true), ImageSizing.orientationFix(4))
        assertEquals(ImageSizing.OrientationFix(270, true), ImageSizing.orientationFix(5))
        assertEquals(ImageSizing.OrientationFix(90, true), ImageSizing.orientationFix(7))
    }

    @Test
    fun an_unknown_or_missing_orientation_leaves_the_image_untouched() {
        for (value in listOf(0, 9, -1, 255)) {
            assertTrue("orientation $value", ImageSizing.orientationFix(value).isIdentity)
        }
        assertFalse(ImageSizing.orientationFix(6).isIdentity)
    }

    @Test
    fun the_request_limits_match_the_contract() {
        assertEquals(1024, ImageSizing.MAX_LONGEST_SIDE)
        assertEquals(4, ImageSizing.MAX_IMAGES)
    }
}
