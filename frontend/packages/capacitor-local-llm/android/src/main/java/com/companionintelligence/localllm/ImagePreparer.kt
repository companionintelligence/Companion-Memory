package com.companionintelligence.localllm

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Pure sizing and orientation math for the images a vision model is given — separate from
 * [ImagePreparer] so it needs no `Bitmap` and no Robolectric.
 */
object ImageSizing {
    /** Longest side, in pixels, handed to the model. Gemma 4's vision tower resizes to a budget anyway. */
    const val MAX_LONGEST_SIDE = 1024

    /** Images accepted per `generate` call. */
    const val MAX_IMAGES = 4

    /** Largest decoded (post-base64) image accepted, so a runaway payload fails fast. */
    const val MAX_IMAGE_BYTES = 20 * 1024 * 1024

    data class Size(val width: Int, val height: Int)

    /** [width] x [height] scaled so the longest side is at most [maxSide], keeping the aspect ratio. Never upscales. */
    fun targetSize(width: Int, height: Int, maxSide: Int = MAX_LONGEST_SIDE): Size {
        require(width > 0 && height > 0) { "image has no pixels ($width x $height)" }
        val longest = maxOf(width, height)
        if (longest <= maxSide) return Size(width, height)
        val scale = maxSide.toDouble() / longest
        return Size(
            width = Math.round(width * scale).toInt().coerceAtLeast(1),
            height = Math.round(height * scale).toInt().coerceAtLeast(1),
        )
    }

    /**
     * `BitmapFactory.Options.inSampleSize` for decoding: the largest power of two that still leaves
     * the decoded longest side at or above [maxSide]. Decoding a 48 MP photo at full size would need
     * ~190 MB of bitmap; sampling first keeps the peak small, and the exact resize follows from
     * [targetSize] on the smaller bitmap.
     */
    fun sampleSize(width: Int, height: Int, maxSide: Int = MAX_LONGEST_SIDE): Int {
        val longest = maxOf(width, height)
        var sample = 1
        while (longest / (sample * 2) >= maxSide) sample *= 2
        return sample
    }

    /** What EXIF orientation asks for: rotate clockwise by [degrees], after mirroring left-right if [mirror]. */
    data class OrientationFix(val degrees: Int, val mirror: Boolean) {
        val isIdentity: Boolean get() = degrees == 0 && !mirror
    }

    /** Maps the EXIF `Orientation` tag (1-8) to the transform that turns the stored pixels upright. */
    fun orientationFix(exifOrientation: Int): OrientationFix =
        when (exifOrientation) {
            2 -> OrientationFix(0, true) // mirrored
            3 -> OrientationFix(180, false)
            4 -> OrientationFix(180, true) // mirrored vertically
            5 -> OrientationFix(270, true) // transpose
            6 -> OrientationFix(90, false)
            7 -> OrientationFix(90, true) // transverse
            8 -> OrientationFix(270, false)
            else -> OrientationFix(0, false)
        }
}

/**
 * Turns the base64 image a `generate` call carries into the PNG bytes LiteRT-LM's
 * `Content.ImageBytes` takes: decoded, upright, at most [ImageSizing.MAX_LONGEST_SIDE] on its
 * longest side. Mirrors what Google AI Edge Gallery does (bitmap → `Bitmap.compress(PNG)`), with the
 * downscale and the EXIF rotation added because a phone photo arrives at 12-50 MP, sideways.
 *
 * Every failure is an [IllegalArgumentException] naming the image, so the plugin can reject the whole
 * call — an image that cannot be read is never silently left out of the prompt.
 */
object ImagePreparer {

    /** @param index the image's 1-based position in the call, for the error message. */
    fun toPng(index: Int, base64: String): ByteArray {
        val label = "Image $index"
        if (base64.startsWith("data:")) {
            throw IllegalArgumentException("$label must be bare base64, without a data: prefix.")
        }
        val bytes =
            try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("$label is not valid base64.", e)
            }
        if (bytes.isEmpty()) throw IllegalArgumentException("$label is empty.")
        if (bytes.size > ImageSizing.MAX_IMAGE_BYTES) {
            throw IllegalArgumentException("$label is larger than ${ImageSizing.MAX_IMAGE_BYTES / (1024 * 1024)} MB.")
        }

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalArgumentException("$label could not be decoded as a JPEG or PNG image.")
        }

        val decodeOptions =
            BitmapFactory.Options().apply {
                inSampleSize = ImageSizing.sampleSize(bounds.outWidth, bounds.outHeight)
            }
        val decoded =
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOptions)
                ?: throw IllegalArgumentException("$label could not be decoded as a JPEG or PNG image.")

        var bitmap = decoded
        try {
            bitmap = applyOrientation(bytes, bitmap)
            val target = ImageSizing.targetSize(bitmap.width, bitmap.height)
            if (target.width != bitmap.width || target.height != bitmap.height) {
                val scaled = Bitmap.createScaledBitmap(bitmap, target.width, target.height, /* filter = */ true)
                if (scaled !== bitmap) {
                    bitmap.recycle()
                    bitmap = scaled
                }
            }
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                throw IllegalArgumentException("$label could not be re-encoded.")
            }
            return out.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    /** Rotates/mirrors [bitmap] upright per the EXIF tag of [source] (a no-op for PNG and untagged JPEG). */
    private fun applyOrientation(source: ByteArray, bitmap: Bitmap): Bitmap {
        // ExifInterface(InputStream) is API 24+; the plugin as a whole is gated to API 26 by isAvailable().
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return bitmap
        val orientation =
            try {
                ExifInterface(ByteArrayInputStream(source))
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Exception) {
                ExifInterface.ORIENTATION_NORMAL
            }
        val fix = ImageSizing.orientationFix(orientation)
        if (fix.isIdentity) return bitmap

        val matrix = Matrix()
        if (fix.mirror) matrix.postScale(-1f, 1f)
        if (fix.degrees != 0) matrix.postRotate(fix.degrees.toFloat())
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated !== bitmap) bitmap.recycle()
        return rotated
    }
}
