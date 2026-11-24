package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** The pure half of {@link WebViewDownloads}: what a download gets saved as. */
public class WebViewDownloadsFileNameTest {
    private static final String SIGNED_OBJECT_URL =
            "http://localhost:5173/static/companion/8ce24a93-c107-48a0-a730-4ad8932945d1"
                    + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&response-content-type=image%2Fsvg%2Bxml&x-id=GetObject";

    @Test
    public void a_quoted_content_disposition_name_wins_over_the_url() {
        assertEquals(
                "White Ice Cream Icon PANTS",
                WebViewDownloads.fileName(SIGNED_OBJECT_URL, "attachment; filename=\"White Ice Cream Icon PANTS\""));
    }

    @Test
    public void an_unquoted_content_disposition_name_is_trimmed() {
        assertEquals("report.pdf", WebViewDownloads.fileName(SIGNED_OBJECT_URL, "attachment; filename= report.pdf ;"));
    }

    @Test
    public void an_rfc5987_encoded_name_is_decoded_and_preferred() {
        assertEquals(
                "résumé.pdf",
                WebViewDownloads.fileName(
                        SIGNED_OBJECT_URL,
                        "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"));
    }

    @Test
    public void without_a_header_the_last_path_segment_is_used_and_the_query_is_dropped() {
        assertEquals("8ce24a93-c107-48a0-a730-4ad8932945d1", WebViewDownloads.fileName(SIGNED_OBJECT_URL, null));
        assertEquals("photo.jpg", WebViewDownloads.fileName("https://host/a/b/photo.jpg#x", "inline"));
    }

    @Test
    public void a_percent_encoded_path_segment_is_decoded() {
        assertEquals("my file.txt", WebViewDownloads.fileName("https://host/files/my%20file.txt", null));
    }

    @Test
    public void a_bare_origin_or_trailing_slash_falls_back_to_a_default() {
        assertEquals("download", WebViewDownloads.fileName("https://host", null));
        assertEquals("download", WebViewDownloads.fileName("https://host/folder/", null));
        assertNull(WebViewDownloads.fileNameFromUrl("https://host"));
    }

    @Test
    public void path_separators_cannot_escape_the_downloads_folder() {
        assertEquals("_.._etc_passwd", WebViewDownloads.fileName(SIGNED_OBJECT_URL, "attachment; filename=\"/../etc/passwd\""));
    }
}
