package com.companionintelligence.localllm

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/**
 * [ImagePreparer] against real bitmaps. Robolectric's default ("legacy") graphics shadows
 * `BitmapFactory`/`Bitmap` with stand-ins that neither decode nor encode, which would make every
 * assertion here vacuous; NATIVE mode runs the real Skia code.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ImagePreparerTest {

    /** Left half red, right half blue — asymmetric, so a rotation in the wrong direction is visible. */
    private fun splitBitmap(width: Int, height: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        paint.color = Color.RED
        canvas.drawRect(0f, 0f, width / 2f, height.toFloat(), paint)
        paint.color = Color.BLUE
        canvas.drawRect(width / 2f, 0f, width.toFloat(), height.toFloat(), paint)
        return bitmap
    }

    private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat): ByteArray {
        val out = ByteArrayOutputStream()
        check(bitmap.compress(format, 95, out))
        return out.toByteArray()
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decoded(png: ByteArray): Bitmap = BitmapFactory.decodeByteArray(png, 0, png.size)

    private fun assertReddish(pixel: Int, what: String) =
        assertTrue("$what should be red, was #${Integer.toHexString(pixel)}", Color.red(pixel) > 150 && Color.blue(pixel) < 100)

    private fun assertBluish(pixel: Int, what: String) =
        assertTrue("$what should be blue, was #${Integer.toHexString(pixel)}", Color.blue(pixel) > 150 && Color.red(pixel) < 100)

    @Test
    fun a_large_photo_comes_back_as_a_png_with_its_longest_side_at_1024() {
        val jpeg = encode(splitBitmap(3000, 2000), Bitmap.CompressFormat.JPEG)

        val png = ImagePreparer.toPng(1, b64(jpeg))

        // PNG signature: the bytes go to Content.ImageBytes, so the container matters.
        assertEquals(listOf(0x89, 0x50, 0x4E, 0x47), png.take(4).map { it.toInt() and 0xFF })
        val result = decoded(png)
        assertEquals(1024, result.width)
        assertEquals(683, result.height)
        // Content survived the downscale.
        assertReddish(result.getPixel(50, 300), "left side")
        assertBluish(result.getPixel(970, 300), "right side")
    }

    @Test
    fun a_small_image_is_re_encoded_at_its_own_size_never_enlarged() {
        val png = ImagePreparer.toPng(1, b64(encode(splitBitmap(300, 200), Bitmap.CompressFormat.PNG)))

        val result = decoded(png)
        assertEquals(300, result.width)
        assertEquals(200, result.height)
    }

    @Test
    fun a_tall_photo_is_capped_on_its_height() {
        val result = decoded(ImagePreparer.toPng(1, b64(encode(splitBitmap(1500, 6000), Bitmap.CompressFormat.PNG))))

        assertEquals(256, result.width)
        assertEquals(1024, result.height)
    }

    @Test
    fun exif_orientation_6_is_applied_so_a_portrait_photo_arrives_upright() {
        // Stored landscape (300 x 200, red left / blue right) and tagged "rotate 90 clockwise".
        val jpeg = withExifOrientation(encode(splitBitmap(300, 200), Bitmap.CompressFormat.JPEG), ExifInterface.ORIENTATION_ROTATE_90)

        val result = decoded(ImagePreparer.toPng(1, b64(jpeg)))

        assertEquals("width and height swap", 200, result.width)
        assertEquals(300, result.height)
        // Rotating clockwise puts the old left edge (red) at the top and the old right edge (blue) at the bottom.
        assertReddish(result.getPixel(100, 20), "top")
        assertBluish(result.getPixel(100, 280), "bottom")
    }

    @Test
    fun an_untagged_jpeg_is_not_rotated() {
        val result = decoded(ImagePreparer.toPng(1, b64(encode(splitBitmap(300, 200), Bitmap.CompressFormat.JPEG))))

        assertEquals(300, result.width)
        assertEquals(200, result.height)
        assertReddish(result.getPixel(20, 100), "left")
        assertBluish(result.getPixel(280, 100), "right")
    }

    @Test
    fun a_data_uri_is_refused_because_the_contract_is_bare_base64() {
        val png = encode(splitBitmap(10, 10), Bitmap.CompressFormat.PNG)

        val error = failure { ImagePreparer.toPng(2, "data:image/png;base64," + b64(png)) }

        assertTrue(error, error.contains("Image 2") && error.contains("data:"))
    }

    @Test
    fun undecodable_input_names_the_image_and_says_why() {
        assertTrue(failure { ImagePreparer.toPng(1, "") }.contains("Image 1 is empty"))
        assertTrue(failure { ImagePreparer.toPng(3, "%%% not base64 %%%") }.contains("Image 3 is not valid base64"))
        // Valid base64, but the bytes are text, not an image.
        val notAnImage = failure { ImagePreparer.toPng(4, b64("hello, this is not a picture".toByteArray())) }
        assertTrue(notAnImage, notAnImage.contains("Image 4 could not be decoded"))
    }

    @Test
    fun an_absurdly_large_payload_is_refused_before_any_decoding() {
        val huge = b64(ByteArray(ImageSizing.MAX_IMAGE_BYTES + 1))

        val error = failure { ImagePreparer.toPng(1, huge) }

        assertTrue(error, error.contains("larger than"))
    }

    private fun failure(block: () -> Unit): String {
        try {
            block()
        } catch (e: IllegalArgumentException) {
            return e.message ?: ""
        }
        throw AssertionError("expected an IllegalArgumentException")
    }

    /** Writes [orientation] into the JPEG's EXIF block the way a camera would. */
    private fun withExifOrientation(jpeg: ByteArray, orientation: Int): ByteArray {
        val file = File.createTempFile("exif", ".jpg")
        try {
            file.writeBytes(jpeg)
            val exif = ExifInterface(file.absolutePath)
            exif.setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
            exif.saveAttributes()
            return file.readBytes()
        } finally {
            file.delete()
        }
    }
}
