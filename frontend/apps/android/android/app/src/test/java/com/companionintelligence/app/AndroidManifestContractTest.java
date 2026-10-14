package com.companionintelligence.app;

import static com.companionintelligence.app.SourceManifest.attr;
import static com.companionintelligence.app.SourceManifest.elements;
import static com.companionintelligence.app.SourceManifest.names;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Before;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

/**
 * The app manifest is hand-maintained and nothing in the build verifies its
 * contents: every declaration below is load-bearing only at runtime, on a real
 * device, in a flow a smoke test does not reach (a browser handing back an OIDC
 * deep link, a user picking "Approximate" at a location prompt, TextToSpeech
 * binding to an engine in another package). Deleting any of them produces a
 * green build, a launching app, and a silently broken feature.
 *
 * <p>These read the manifest SOURCE rather than the merged output on purpose:
 * the source is the file a human edits, and it is the one under review. The
 * merged-manifest counterpart lives in {@link MergedManifestPermissionsTest}.
 */
public class AndroidManifestContractTest {

    private Document manifest;

    @Before
    public void parseManifest() {
        manifest = SourceManifest.parse();
    }

    /**
     * Play Console registered {@code com.ci.memory}. The Java/Kotlin namespace and the
     * iOS bundle id stay on {@code com.companionintelligence.app}. Changing applicationId
     * in one file and not the others is how an AAB gets rejected at upload.
     */
    @Test
    public void play_target_sdk_is_36() {
        assertEquals(
            "Play rejects uploads below target API 36. compileSdk and targetSdk move together.",
            "36",
            matchOne(
                new File(ProjectFiles.appModuleDir(), "../variables.gradle"),
                "targetSdkVersion\\s*=\\s*(\\d+)",
                "targetSdkVersion"
            )
        );
        assertEquals(
            "compileSdkVersion must stay at 36 with targetSdk 36.",
            "36",
            matchOne(
                new File(ProjectFiles.appModuleDir(), "../variables.gradle"),
                "compileSdkVersion\\s*=\\s*(\\d+)",
                "compileSdkVersion"
            )
        );
    }

    @Test
    public void play_application_id_is_com_ci_memory() {
        assertEquals(
            "Android applicationId must stay com.ci.memory (the Play Console package).",
            "com.ci.memory",
            matchOne(new File(ProjectFiles.appModuleDir(), "build.gradle"), "applicationId\\s+\"([^\"]+)\"", "applicationId")
        );
        assertEquals(
            "Android namespace must stay com.companionintelligence.app so the existing Java package does not move.",
            "com.companionintelligence.app",
            matchOne(new File(ProjectFiles.appModuleDir(), "build.gradle"), "namespace\\s+\"([^\"]+)\"", "namespace")
        );
        assertEquals(
            "capacitor.config.ts appId must match the Play applicationId or the next cap sync will revert it.",
            "com.ci.memory",
            matchOne(
                ProjectFiles.inRepo("frontend/apps/android/capacitor.config.ts"),
                "appId:\\s*'([^']+)'",
                "capacitor.config.ts appId"
            )
        );
        assertEquals(
            "iOS bundle id is unchanged: Play's package rename is Android-only.",
            "com.companionintelligence.app",
            matchOne(
                ProjectFiles.inRepo("frontend/apps/ios/capacitor.config.ts"),
                "appId:\\s*'([^']+)'",
                "iOS capacitor.config.ts appId"
            )
        );
    }

    @Test
    public void main_activity_is_exported_and_reuses_its_existing_task() {
        Element activity = mainActivity();

        // exported=true is what lets the browser deliver the OIDC callback at all.
        assertEquals(
            "MainActivity must stay android:exported=\"true\" or no external VIEW intent -- including the "
                + "OIDC/Portal deep-link return -- can ever reach it.",
            "true",
            attr(activity, "exported")
        );

        // singleTask is what makes the callback resume the *existing* activity. Under the
        // default "standard" mode the deep link spawns a second MainActivity, which boots a
        // second WebView with no in-flight PKCE verifier, so the exchange fails with a
        // mismatch that looks like a backend bug.
        assertEquals(
            "MainActivity must stay android:launchMode=\"singleTask\" so the deep-link callback resumes the "
                + "running app instead of launching a second instance that has lost the PKCE state.",
            "singleTask",
            attr(activity, "launchMode")
        );
    }

    @Test
    public void both_the_appliance_and_portal_deep_link_callbacks_are_claimed() {
        Element viewFilter = viewIntentFilter();

        List<String> categories = names(viewFilter, "category");
        assertTrue(
            "The VIEW intent-filter needs android.intent.category.DEFAULT, otherwise it cannot be the "
                + "target of an implicit intent. Declared: " + categories,
            categories.contains("android.intent.category.DEFAULT")
        );
        assertTrue(
            "The VIEW intent-filter needs android.intent.category.BROWSABLE, otherwise a browser refuses to "
                + "hand the callback URL to the app. Declared: " + categories,
            categories.contains("android.intent.category.BROWSABLE")
        );

        Set<String> claimed = claimedDeepLinks(viewFilter);

        // Two distinct flows, two distinct hosts. They fail independently: appliance login can
        // keep working while Portal cloud-connect dead-ends in the browser, and vice versa.
        assertTrue(
            "companion://oidc is the CI-Server appliance login return. Claimed deep links: " + claimed,
            claimed.contains("companion://oidc")
        );
        assertTrue(
            "companion://auth is the Portal cloud-connect PKCE return (frontend/apps/web/src/pages/"
                + "DeviceConnectPage/oidc.ts OIDC_REDIRECT_URI). Claimed deep links: " + claimed,
            claimed.contains("companion://auth")
        );
    }

    /**
     * The custom scheme is one string duplicated across four files in three languages,
     * with no build step, type or lint rule tying them together. Changing it in one
     * place breaks exactly one platform, silently.
     */
    @Test
    public void the_deep_link_scheme_is_the_same_string_on_android_ios_web_and_the_backend() {
        Set<String> androidSchemes = new LinkedHashSet<>();
        for (Element data : elements(viewIntentFilter(), "data")) {
            androidSchemes.add(attr(data, "scheme"));
        }
        assertEquals(
            "Every <data> in MainActivity's VIEW filter must use the one native scheme; found " + androidSchemes,
            1,
            androidSchemes.size()
        );

        String android = androidSchemes.iterator().next();
        assertFalse("MainActivity's VIEW filter declares no android:scheme.", android.isEmpty());

        String web = matchOne(
            ProjectFiles.inRepo("frontend/packages/common/src/utils/oidcNative.ts"),
            "OIDC_NATIVE_SCHEME\\s*=\\s*'([^']+)'",
            "OIDC_NATIVE_SCHEME"
        );
        String ios = matchOne(
            ProjectFiles.inRepo("frontend/apps/ios/ios/App/App/Info.plist"),
            "CFBundleURLSchemes</key>\\s*<array>\\s*<string>([^<]+)</string>",
            "the first CFBundleURLSchemes entry"
        );
        String backend = matchOne(
            ProjectFiles.inRepo("backend/apps/api/config/default.json"),
            "\"nativeRedirectScheme\"\\s*:\\s*\"([^\"]+)\"",
            "auth.oidc.nativeRedirectScheme"
        );

        assertEquals(
            "@ci/common OIDC_NATIVE_SCHEME drifted from the Android manifest -- Android sign-in would never "
                + "return to the app while web and iOS keep working.",
            android,
            web
        );
        assertEquals(
            "iOS Info.plist CFBundleURLSchemes drifted from the Android manifest.",
            android,
            ios
        );
        assertEquals(
            "The backend redirects native sign-in to auth.oidc.nativeRedirectScheme://oidc/callback; it drifted "
                + "from the scheme Android actually claims, so the redirect would land nowhere.",
            android,
            backend
        );
    }

    /**
     * Both location permissions must be declared as a pair. FINE alone still shows a
     * runtime prompt, and that prompt offers the user an "Approximate" button -- which
     * grants COARSE. If COARSE is not declared, picking it grants nothing at all, and
     * background geolocation then records nothing with no crash and no log line.
     */
    @Test
    public void location_is_declared_as_a_coarse_and_fine_pair() {
        List<String> permissions = SourceManifest.declaredPermissions();

        assertTrue(
            "ACCESS_FINE_LOCATION is missing. Declared: " + permissions,
            permissions.contains("android.permission.ACCESS_FINE_LOCATION")
        );
        assertTrue(
            "ACCESS_COARSE_LOCATION is missing while FINE is declared. The runtime prompt's \"Approximate\" "
                + "choice then grants no permission at all instead of a degraded one. Declared: " + permissions,
            permissions.contains("android.permission.ACCESS_COARSE_LOCATION")
        );

        // "Always" mode records through the plugin's location-typed foreground service, which the
        // person starts from inside the app, so Android treats it as while-in-use access. Without
        // the typed declaration that service cannot start on API 34+.
        assertTrue(
            "FOREGROUND_SERVICE_LOCATION is missing -- a location-typed foreground service is refused at "
                + "startActivity time on Android 14+. Declared: " + permissions,
            permissions.contains("android.permission.FOREGROUND_SERVICE_LOCATION")
        );
        // Nothing requests ACCESS_BACKGROUND_LOCATION at runtime. Declaring it alone makes Play
        // review the app as accessing location in the background (declaration form, demo video
        // and a "core functionality" judgement). It is the permission the 2026-10-06 Play
        // rejection named.
        assertFalse(
            "ACCESS_BACKGROUND_LOCATION is declared again. \"Always\" doesn't need it: its foreground service "
                + "has while-in-use access. Declaring it puts the app through Play's background-location "
                + "review. Declared: " + permissions,
            permissions.contains("android.permission.ACCESS_BACKGROUND_LOCATION")
        );
    }

    @Test
    public void the_capture_and_notification_permissions_the_app_depends_on_are_declared() {
        List<String> permissions = SourceManifest.declaredPermissions();

        List<String> required = Arrays.asList(
            "android.permission.INTERNET",
            "android.permission.CAMERA",
            "android.permission.RECORD_AUDIO",
            "android.permission.MODIFY_AUDIO_SETTINGS",
            "android.permission.POST_NOTIFICATIONS"
        );

        List<String> missing = new ArrayList<>();
        for (String permission : required) {
            if (!permissions.contains(permission)) {
                missing.add(permission);
            }
        }

        assertTrue(
            "Permissions the in-webview capture and notification paths need are no longer declared: " + missing
                + ". getUserMedia() and the Android 13+ notification prompt fail at use time, on device only.",
            missing.isEmpty()
        );
    }

    /**
     * Package-visibility filtering (Android 11+, and this module declares the targetSdk that
     * triggers it) hides every text-to-speech engine unless the app declares the query.
     * Without it TextToSpeech's OnInitListener fires with ERROR, no voice is ever available,
     * and there is no other diagnostic anywhere.
     */
    @Test
    public void text_to_speech_engines_stay_visible_under_package_visibility_filtering() {
        List<Element> queries = elements(manifest, "queries");
        assertFalse("The manifest declares no <queries> element at all.", queries.isEmpty());

        boolean declaresTtsQuery = false;
        for (Element query : queries) {
            for (Element intent : elements(query, "intent")) {
                if (names(intent, "action").contains("android.intent.action.TTS_SERVICE")) {
                    declaresTtsQuery = true;
                }
            }
        }

        assertTrue(
            "No <queries><intent><action android:name=\"android.intent.action.TTS_SERVICE\"/> declaration. "
                + "Every TTS engine lives in its own package and an app targeting API 30+ cannot see, or bind "
                + "to, a package it has not declared a query for.",
            declaresTtsQuery
        );
    }

    /**
     * @capacitor/camera hands the OS a content:// URI minted by this provider. The authority
     * and the roots in file_paths.xml are matched by string at capture time; a mismatch throws
     * "Failed to find configured root" on device and never at build time.
     */
    @Test
    public void the_file_provider_authority_and_roots_match_what_capacitor_camera_expects() {
        Element provider = null;
        for (Element candidate : elements(manifest, "provider")) {
            if ("androidx.core.content.FileProvider".equals(attr(candidate, "name"))) {
                provider = candidate;
            }
        }
        assertTrue("The manifest declares no androidx.core.content.FileProvider <provider>.", provider != null);

        assertEquals(
            "The FileProvider authority must stay \"${applicationId}.fileprovider\" -- that exact suffix is what "
                + "@capacitor/camera builds its URIs against.",
            "${applicationId}.fileprovider",
            attr(provider, "authorities")
        );
        assertEquals(
            "A FileProvider must not be exported; exporting it hands every other app on the device read access "
                + "to the declared roots.",
            "false",
            attr(provider, "exported")
        );
        assertEquals(
            "grantUriPermissions must stay true, otherwise the per-URI grant the camera intent relies on is "
                + "never issued and the receiving app gets a SecurityException.",
            "true",
            attr(provider, "grantUriPermissions")
        );

        String pathsResource = null;
        for (Element metaData : elements(provider, "meta-data")) {
            if ("android.support.FILE_PROVIDER_PATHS".equals(attr(metaData, "name"))) {
                pathsResource = attr(metaData, "resource");
            }
        }
        assertEquals(
            "The FileProvider's android.support.FILE_PROVIDER_PATHS meta-data must point at @xml/file_paths.",
            "@xml/file_paths",
            pathsResource
        );

        Document paths = SourceManifest.parseXml(new File(ProjectFiles.appModuleDir(), "src/main/res/xml/file_paths.xml"));
        // Note: file_paths.xml declares its attributes UNPREFIXED (name=, path=), unlike the
        // manifest, so these are read without the android namespace.
        assertEquals(
            "file_paths.xml must keep the external-path root named \"my_images\".",
            "my_images",
            firstAttribute(paths, "external-path", "name")
        );
        assertEquals(
            "file_paths.xml must keep the cache-path root named \"my_cache_images\".",
            "my_cache_images",
            firstAttribute(paths, "cache-path", "name")
        );
    }

    private Element mainActivity() {
        for (Element activity : elements(manifest, "activity")) {
            if (".MainActivity".equals(attr(activity, "name"))) {
                return activity;
            }
        }
        throw new AssertionError("No <activity android:name=\".MainActivity\"> in app/src/main/AndroidManifest.xml.");
    }

    private Element viewIntentFilter() {
        for (Element filter : elements(mainActivity(), "intent-filter")) {
            if (names(filter, "action").contains("android.intent.action.VIEW")) {
                return filter;
            }
        }
        throw new AssertionError(
            "MainActivity has no VIEW <intent-filter>. Both the appliance OIDC callback and the Portal "
                + "cloud-connect callback arrive through it; without it, sign-in never returns to the app."
        );
    }

    /** Every {@code scheme://host} pair the given intent-filter claims. */
    private static Set<String> claimedDeepLinks(Element intentFilter) {
        Set<String> claimed = new LinkedHashSet<>();
        for (Element data : elements(intentFilter, "data")) {
            claimed.add(attr(data, "scheme") + "://" + attr(data, "host"));
        }
        return claimed;
    }

    private static String firstAttribute(Document document, String tagName, String attribute) {
        List<Element> found = SourceManifest.elements(document, tagName);
        assertFalse("No <" + tagName + "> element found.", found.isEmpty());
        return found.get(0).getAttribute(attribute);
    }

    private static String matchOne(File file, String regex, String what) {
        Matcher matcher = Pattern.compile(regex).matcher(ProjectFiles.read(file));
        assertTrue(
            "Could not find " + what + " in " + file + " with /" + regex + "/. Either the declaration was "
                + "removed or it was reshaped -- both need a human to re-check the four-file scheme contract.",
            matcher.find()
        );
        return matcher.group(1);
    }
}
