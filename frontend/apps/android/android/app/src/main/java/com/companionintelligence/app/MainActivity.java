package com.companionintelligence.app;

import android.content.Context;
import android.os.Bundle;
import com.companionintelligence.localhub.AuthTabSession;
import com.companionintelligence.localhub.StoredDeviceCredential;
import com.companionintelligence.localllm.intents.IntentCredential;
import com.companionintelligence.localllm.intents.IntentCredentials;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate: the Auth Tab launcher has to exist before the
        // activity is started, and the app's own plugins have to be on the builder
        // before BridgeActivity.load() freezes it. See the registration test.
        AuthTabSession.register(this);
        // The on-device model's intent tools call Memory with the device key, read from Local
        // Hub's credential store at request time: the page holds only short-lived tokens now.
        // Wired here because this module is the one with both plugins on its classpath.
        final Context appContext = getApplicationContext();
        IntentCredentials.install(() -> {
            StoredDeviceCredential stored = StoredDeviceCredential.read(appContext);
            return stored == null ? null : new IntentCredential(stored.getBaseUrl(), stored.getApiKey());
        });
        registerPlugin(FcmStatusPlugin.class);
        registerPlugin(SystemBarsPlugin.class);
        super.onCreate(savedInstanceState);

        // After super.onCreate: BridgeActivity.load() has built the bridge and its
        // WebView by now. Without a DownloadListener the WebView discards every
        // download (see WebViewDownloads).
        if (bridge != null && bridge.getWebView() != null) {
            WebViewDownloads.attach(this, bridge.getWebView());
            // Android 15+: inset the WebView from the system bars and the keyboard (see
            // WebViewInsets for why Capacitor's adjustMarginsForEdgeToEdge is not used).
            WebViewInsets.attach(bridge.getWebView());
        }
    }
}
