package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;

import androidx.core.graphics.Insets;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class WebViewInsetsTest {

    @Test
    public void with_the_keyboard_closed_the_margins_are_the_system_bars_and_cutout() {
        Insets margins = WebViewInsets.margins(Insets.of(0, 126, 0, 168), Insets.of(0, 0, 0, 0));

        assertEquals(Insets.of(0, 126, 0, 168), margins);
    }

    @Test
    public void with_the_keyboard_open_the_bottom_margin_is_the_keyboard_so_the_page_shrinks_above_it() {
        // The IME inset is measured from the window edge, so it already spans the navigation bar.
        Insets margins = WebViewInsets.margins(Insets.of(0, 126, 0, 168), Insets.of(0, 0, 0, 1240));

        assertEquals(Insets.of(0, 126, 0, 1240), margins);
    }

    @Test
    public void a_keyboard_shorter_than_the_navigation_bar_never_lets_the_page_back_under_the_bar() {
        Insets margins = WebViewInsets.margins(Insets.of(0, 126, 0, 168), Insets.of(0, 0, 0, 40));

        assertEquals(168, margins.bottom);
    }
}
