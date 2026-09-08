package com.companionintelligence.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * The source manifest is only half the story: what ships is the merged manifest, and
 * a library manifest can subtract from it -- {@code tools:node="remove"} on a
 * {@code <uses-permission>} is a real and common thing for a dependency to do, usually
 * to make its own Play submission simpler. This module pulls in seventeen Capacitor and
 * Cordova library modules, none of them ours.
 *
 * <p>{@link AndroidManifestContractTest} asserts the app *asks* for its permissions;
 * this asserts the merger did not quietly drop one on the way to the APK.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class MergedManifestPermissionsTest {

    @Test
    public void every_permission_the_app_declares_survives_manifest_merging() throws Exception {
        Application application = RuntimeEnvironment.getApplication();
        PackageInfo packageInfo = application
            .getPackageManager()
            .getPackageInfo(application.getPackageName(), PackageManager.GET_PERMISSIONS);

        assertNotNull(
            "The merged manifest requests no permissions at all, which cannot be right for this app.",
            packageInfo.requestedPermissions
        );
        List<String> merged = Arrays.asList(packageInfo.requestedPermissions);

        List<String> dropped = new ArrayList<>();
        for (String declared : SourceManifest.declaredPermissions()) {
            if (!merged.contains(declared)) {
                dropped.add(declared);
            }
        }

        assertTrue(
            "app/src/main/AndroidManifest.xml declares these permissions but the MERGED manifest does not "
                + "request them: " + dropped + ". A library manifest most likely removed them with "
                + "tools:node=\"remove\". Merged set was: " + merged,
            dropped.isEmpty()
        );
    }
}
