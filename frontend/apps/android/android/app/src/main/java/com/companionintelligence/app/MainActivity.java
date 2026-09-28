package com.companionintelligence.app;

import android.os.Bundle;
import com.companionintelligence.localhub.AuthTabSession;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate: the Auth Tab launcher has to exist before the
        // activity is started, and FcmStatusPlugin has to be on the builder
        // before BridgeActivity.load() freezes it. See the registration test.
        AuthTabSession.register(this);
        registerPlugin(FcmStatusPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
