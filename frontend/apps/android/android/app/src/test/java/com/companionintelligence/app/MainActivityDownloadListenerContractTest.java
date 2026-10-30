package com.companionintelligence.app;

import static org.junit.Assert.assertTrue;

import java.io.File;
import org.junit.Test;

/**
 * {@link WebViewDownloads#attach} has to run AFTER {@code super.onCreate}: that is
 * when {@code BridgeActivity.load()} creates the bridge and its WebView. Before it,
 * {@code bridge} is null and the guard in MainActivity silently skips the listener,
 * which reverts every Download button in the web app to a no-op. Pinned at source
 * level because Robolectric cannot boot the Capacitor bridge to observe the listener.
 */
public class MainActivityDownloadListenerContractTest {
    @Test
    public void the_download_listener_is_attached_after_the_bridge_is_built() {
        String source = ProjectFiles.read(
                new File(ProjectFiles.appModuleDir(), "src/main/java/com/companionintelligence/app/MainActivity.java"));
        int superOnCreate = source.indexOf("super.onCreate(savedInstanceState);");
        int attach = source.indexOf("WebViewDownloads.attach(this, bridge.getWebView());");

        assertTrue("MainActivity must call super.onCreate", superOnCreate >= 0);
        assertTrue("MainActivity must attach WebViewDownloads", attach >= 0);
        assertTrue("WebViewDownloads.attach must come after super.onCreate", attach > superOnCreate);
    }
}
