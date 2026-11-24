package com.companionintelligence.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hands the WebView's downloads to Android's DownloadManager.
 *
 * <p>A WebView has no download behaviour of its own: a link with a {@code download}
 * attribute, or any response served as {@code Content-Disposition: attachment}, is
 * dropped on the floor unless the host app registers a {@link android.webkit.DownloadListener}.
 * Capacitor registers none, so every Download button in the web app was a silent
 * no-op on Android (the Open button next to it works because it is a plain
 * navigation). Nothing covered the button; the tap arrived and went nowhere.
 *
 * <p>The request carries the WebView's cookies and User-Agent for the URL so an
 * origin that keys on either still answers. Files land in the public Downloads
 * folder with a completion notification; below API 29 that folder needs a storage
 * permission the app does not hold, so those devices get the app's own external
 * files directory instead.
 */
final class WebViewDownloads {
    private static final String TAG = "WebViewDownloads";
    private static final String DEFAULT_NAME = "download";

    // RFC 6266 / RFC 5987: filename*=charset'lang'percent-encoded, then plain filename=.
    private static final Pattern EXTENDED_FILENAME =
            Pattern.compile("filename\\*\\s*=\\s*([\\w-]+)'[^']*'([^;]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PLAIN_FILENAME =
            Pattern.compile("filename\\s*=\\s*(?:\"([^\"]*)\"|([^;]+))", Pattern.CASE_INSENSITIVE);

    private WebViewDownloads() {}

    static void attach(Activity activity, WebView webView) {
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                enqueue(activity, url, userAgent, contentDisposition, mimeType));
    }

    private static void enqueue(
            Activity activity, String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);

        if (!scheme.equals("http") && !scheme.equals("https")) {
            // DownloadManager only fetches over HTTP(S); a blob:/data: URL never reaches here
            // from the app's own links, but say so rather than fail silently.
            Log.w(TAG, "Not downloading unsupported scheme: " + scheme);
            Toast.makeText(activity, "Can't download this file", Toast.LENGTH_SHORT).show();

            return;
        }

        String name = withExtension(fileName(url, contentDisposition), mimeType);

        try {
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle(name);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            if (mimeType != null && !mimeType.isEmpty()) {
                request.setMimeType(mimeType);
            }

            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }

            String cookies = CookieManager.getInstance().getCookie(url);

            if (cookies != null && !cookies.isEmpty()) {
                request.addRequestHeader("Cookie", cookies);
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            } else {
                request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name);
            }

            DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(activity, "Downloading " + name, Toast.LENGTH_SHORT).show();
        } catch (RuntimeException failure) {
            Log.e(TAG, "Download failed to start: " + url, failure);
            Toast.makeText(activity, "Couldn't download " + name, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * The file name to save under: the Content-Disposition's name when it has one
     * (the {@code download} attribute's value arrives this way), else the last path
     * segment of the URL, else {@value DEFAULT_NAME}. Pure so it can be unit-tested
     * off-device; {@code URLUtil.guessFileName} is the framework's version of this and
     * is not available to a plain JVM test.
     */
    static String fileName(String url, String contentDisposition) {
        String fromHeader = fileNameFromContentDisposition(contentDisposition);

        if (fromHeader != null) {
            return fromHeader;
        }

        String fromUrl = fileNameFromUrl(url);

        return fromUrl != null ? fromUrl : DEFAULT_NAME;
    }

    static String fileNameFromContentDisposition(String contentDisposition) {
        if (contentDisposition == null) {
            return null;
        }

        Matcher extended = EXTENDED_FILENAME.matcher(contentDisposition);

        if (extended.find()) {
            String decoded = decode(extended.group(2).trim(), extended.group(1));

            if (decoded != null) {
                return sanitize(decoded);
            }
        }

        Matcher plain = PLAIN_FILENAME.matcher(contentDisposition);

        if (plain.find()) {
            String value = plain.group(1) != null ? plain.group(1) : plain.group(2);

            return sanitize(value.trim());
        }

        return null;
    }

    static String fileNameFromUrl(String url) {
        if (url == null) {
            return null;
        }

        String path = url;
        int query = path.indexOf('?');

        if (query >= 0) {
            path = path.substring(0, query);
        }

        int fragment = path.indexOf('#');

        if (fragment >= 0) {
            path = path.substring(0, fragment);
        }

        // Skip the scheme's own slashes so "https://host" yields nothing, not "host".
        int schemeEnd = path.indexOf("://");
        int pathStart = schemeEnd >= 0 ? path.indexOf('/', schemeEnd + 3) : 0;

        if (pathStart < 0) {
            return null;
        }

        String segment = path.substring(path.lastIndexOf('/') + 1);

        if (segment.isEmpty()) {
            return null;
        }

        String decoded = decode(segment, "UTF-8");

        return sanitize(decoded != null ? decoded : segment);
    }

    /** Append the MIME type's extension when the name has none, so "8ce24a93" becomes "8ce24a93.svg". */
    static String withExtension(String name, String mimeType) {
        if (name.contains(".") || mimeType == null || mimeType.isEmpty()) {
            return name;
        }

        String type = mimeType.split(";")[0].trim().toLowerCase(Locale.ROOT);
        String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);

        return extension == null || extension.isEmpty() ? name : name + "." + extension;
    }

    private static String sanitize(String name) {
        // DownloadManager rejects path separators; strip anything that could escape the folder.
        String cleaned = name.replace('/', '_').replace('\\', '_').trim();

        return cleaned.isEmpty() ? DEFAULT_NAME : cleaned;
    }

    private static String decode(String value, String charset) {
        try {
            return URLDecoder.decode(value.replace("+", "%2B"), charset);
        } catch (UnsupportedEncodingException | IllegalArgumentException failure) {
            return null;
        }
    }
}
