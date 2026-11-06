package com.cortoba.fieldops.ui.theme

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Guards the brand vector drawables.
 *
 * The mark's gradient is generated from traced artwork, and a non-monotonic or
 * out-of-range stop position makes Skia drop the whole gradient — the logo then
 * renders blank instead of failing the build. That is exactly the kind of defect
 * a compiler cannot catch, so it is asserted here.
 */
class BrandVectorTest {

    private val drawableDir = File("src/main/res/drawable")

    private val offsetRegex = Regex("""android:offset="([0-9.]+)"""")

    @Test
    fun `gradient offsets are inside 0 to 1 and non decreasing`() {
        val vectors = listOf(
            "ic_cortoba_logo.xml",
            "ic_cortoba_mark.xml",
            "ic_launcher_foreground.xml",
        )
        for (name in vectors) {
            val file = File(drawableDir, name)
            assertTrue("$name must exist", file.isFile)

            val offsets = offsetRegex.findAll(file.readText())
                .map { it.groupValues[1].toFloat() }
                .toList()

            assertTrue("$name must declare gradient stops", offsets.isNotEmpty())
            for (o in offsets) {
                assertTrue("$name has an offset outside 0..1: $o", o in 0f..1f)
            }
            for (i in 1 until offsets.size) {
                assertTrue(
                    "$name has non-monotonic gradient offsets: $offsets",
                    offsets[i] >= offsets[i - 1],
                )
            }
        }
    }

    @Test
    fun `launcher foreground keeps the mark inside the adaptive icon safe zone`() {
        // The adaptive-icon safe zone is the inner 66dp of the 108dp canvas.
        val file = File(drawableDir, "ic_launcher_foreground.xml")
        val text = file.readText()
        val scale = Regex("""android:scaleX="([0-9.]+)"""").find(text)?.groupValues?.get(1)?.toFloat()
        val translateX = Regex("""android:translateX="([0-9.]+)"""").find(text)?.groupValues?.get(1)?.toFloat()
        assertTrue("foreground must scale the mark", scale != null && scale > 0f)

        // Mark viewport is 1094.87; the scaled width plus its offset must fit the canvas.
        val drawnWidth = 1094.87f * scale!!
        val right = (translateX ?: 0f) + drawnWidth
        assertTrue("mark overflows the 108dp canvas (right=$right)", right <= 108f)
    }
}
