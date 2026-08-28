import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OIDC_NATIVE_CALLBACK_URL, OIDC_NATIVE_SCHEME } from '@ci/common/src/utils/oidcNative';
import { describe, expect, it } from 'vitest';

/**
 * Guards the native app's on-disk configuration, which nothing else can guard.
 *
 * Two classes of silent breakage live here:
 *
 * 1. The custom URL scheme is written out in FOUR independent places — the iOS
 *    Info.plist, the Android intent-filter, `@ci/common`'s OIDC_NATIVE_SCHEME and the
 *    backend's `auth.oidc.nativeRedirectScheme` default. Nothing links them. If one
 *    drifts, the OIDC callback deep-link stops returning into the app and native
 *    sign-in fails at the last step — with every unit test still green, because each
 *    side is internally consistent.
 *
 * 2. Store-required native settings (the Apple Privacy Manifest, arm64, the Android
 *    backup posture) are easy to lose: regenerating the native projects, or a
 *    `cap sync`, rewrites these files from Capacitor's templates. A revert would only
 *    be discovered at App Review.
 *
 * These parse the real files from disk, so they fail the moment the config drifts.
 */

// Walk up from this file to the repo root (the directory holding both workspaces).
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'frontend')) && existsSync(join(dir, 'backend'))) {
      return dir;
    }

    dir = resolve(dir, '..');
  }

  throw new Error('repo root not found');
}

const ROOT = repoRoot();
const IOS = join(ROOT, 'frontend/apps/ios');
const ANDROID = join(ROOT, 'frontend/apps/android');

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const infoPlist = () => readFileSync(join(IOS, 'ios/App/App/Info.plist'), 'utf8');
const androidManifest = () => readFileSync(join(ANDROID, 'android/app/src/main/AndroidManifest.xml'), 'utf8');

describe('native app config — OIDC deep-link scheme stays in sync', () => {
  it('iOS registers the scheme in CFBundleURLSchemes', () => {
    const plist = infoPlist();
    const schemes = plist.slice(plist.indexOf('CFBundleURLSchemes'));

    expect(schemes).toContain(`<string>${OIDC_NATIVE_SCHEME}</string>`);
  });

  it('Android registers the same scheme on a VIEW/BROWSABLE intent-filter', () => {
    const manifest = androidManifest();

    expect(manifest).toContain(`android:scheme="${OIDC_NATIVE_SCHEME}"`);
    // A scheme without BROWSABLE never receives the browser's redirect.
    expect(manifest).toContain('android.intent.category.BROWSABLE');
  });

  it("the backend's nativeRedirectScheme default matches the clients", () => {
    const configuration = read('backend/apps/api/src/configuration.ts');
    const defaulted = /nativeRedirectScheme[\s\S]{0,400}?\.default\(\s*'([^']+)'\s*\)/.exec(configuration);

    expect(defaulted?.[1]).toBe(OIDC_NATIVE_SCHEME);
  });

  it('the callback URL the app matches on is built from that same scheme', () => {
    // `@ci/common` compares an inbound deep link against this exact string, and the
    // backend redirects to `<scheme>://oidc/callback` — so the host/path must agree too.
    expect(OIDC_NATIVE_CALLBACK_URL).toBe(`${OIDC_NATIVE_SCHEME}://oidc/callback`);
    expect(androidManifest()).toContain('android:host="oidc"');
    expect(androidManifest()).toContain('android:host="auth"');
  });

  it('Portal cloud-connect PKCE returns on companion://auth/callback, not oidc/callback', () => {
    const oidc = read('frontend/apps/web/src/pages/DeviceConnectPage/oidc.ts');

    expect(oidc).toContain("OIDC_CLIENT_ID = 'ci-server'");
    expect(oidc).toContain("OIDC_REDIRECT_URI = 'companion://auth/callback'");
    expect(infoPlist()).toContain('<string>companion</string>');
  });

  it('iOS launch screen letterboxes the splash mark instead of blowing it up', () => {
    const storyboard = readFileSync(join(IOS, 'ios/App/App/Base.lproj/LaunchScreen.storyboard'), 'utf8');

    expect(storyboard).toContain('scaleAspectFit');
    expect(storyboard).not.toContain('scaleAspectFill');
  });
});

describe('native app config — store-required settings are not silently reverted', () => {
  it('ships an Apple Privacy Manifest declaring required-reason APIs', () => {
    const manifestPath = join(IOS, 'ios/App/App/PrivacyInfo.xcprivacy');
    expect(existsSync(manifestPath)).toBe(true);

    const privacy = readFileSync(manifestPath, 'utf8');

    // Apple rejects uploads that use these APIs without a declared reason.
    expect(privacy).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    expect(privacy).toContain('CA92.1');
    expect(privacy).toContain('NSPrivacyAccessedAPITypes');
  });

  it('the Privacy Manifest is wired into the Xcode target (not just present on disk)', () => {
    // A file that is not in Copy-Bundle-Resources never reaches the built app, so the
    // upload is rejected exactly as if it did not exist.
    const pbxproj = readFileSync(join(IOS, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');

    expect(pbxproj).toContain('PrivacyInfo.xcprivacy in Resources');
  });

  it('declares the export-compliance key so uploads skip the encryption prompt', () => {
    const plist = infoPlist();
    const afterKey = plist.slice(plist.indexOf('ITSAppUsesNonExemptEncryption'));

    expect(plist).toContain('ITSAppUsesNonExemptEncryption');
    expect(afterKey.slice(0, 120)).toContain('<false/>');
  });

  it('requires arm64, not the stale 32-bit armv7 template default', () => {
    const plist = infoPlist();
    const capabilities = plist.slice(plist.indexOf('UIRequiredDeviceCapabilities'));
    const array = capabilities.slice(capabilities.indexOf('<array>'), capabilities.indexOf('</array>'));

    // Assert on the declared VALUES, not the surrounding text: the comment here
    // legitimately mentions armv7 to explain why it was removed.
    const declared = [...array.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);

    expect(declared).toContain('arm64');
    expect(declared).not.toContain('armv7');
  });

  it('disables Android backup so a private memory app is not copied to cloud/adb backup', () => {
    expect(androidManifest()).toContain('android:allowBackup="false"');
  });

  it('ships iOS and Android as separate Capacitor packages', () => {
    expect(JSON.parse(readFileSync(join(IOS, 'package.json'), 'utf8')).name).toBe('@ci/fe-ios');
    expect(JSON.parse(readFileSync(join(ANDROID, 'package.json'), 'utf8')).name).toBe('@ci/fe-android');
    expect(existsSync(join(IOS, 'android'))).toBe(false);
    expect(existsSync(join(ANDROID, 'ios'))).toBe(false);
    expect(existsSync(join(ROOT, 'frontend/apps/mobile/capacitor.config.ts'))).toBe(false);
  });

  it('does not request iOS Screen Time, and keeps photo access to the picker story', () => {
    const plist = infoPlist();
    const pbxproj = readFileSync(join(IOS, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');

    // Screen Time / usage stats are the flat bans — nothing in the product asks
    // for them, and both platforms treat them as high-scrutiny declarations.
    expect(plist).not.toContain('FamilyControls');
    expect(pbxproj).not.toContain('DeviceActivity');
    expect(androidManifest()).not.toContain('PACKAGE_USAGE_STATS');

    // Photos are NOT a flat ban, and this assertion used to say they were.
    // `NSPhotoLibraryUsageDescription` is present deliberately: Capacitor's
    // Camera/Photos APIs are linked even though the product path is
    // picker-style, and Apple rejects the upload without the key. See
    // frontend/apps/ios/DEVICE_DATA_COMPLIANCE.md § 3.5 — "Re-file the
    // nutrition label if the app ever does a full-library read."
    //
    // So what is worth guarding is the *purpose string*, which is the part a
    // reviewer reads and the part that would have to change first if the app
    // ever did start reading the whole library.
    expect(plist).toContain('NSPhotoLibraryAddUsageDescription');
    expect(plist).toContain('NSPhotoLibraryUsageDescription');
    expect(plist).toContain('Companion reads photos you choose');
  });

  it('keeps the iOS cleartext exception scoped to web content, not app-wide', () => {
    const plist = infoPlist();

    // The appliance is often plain http on a LAN, but the narrow exception is the
    // App-Store-preferred form; NSAllowsArbitraryLoads (app-wide) invites scrutiny.
    expect(plist).toContain('NSAllowsArbitraryLoadsInWebContent');
    expect(plist).not.toContain('<key>NSAllowsArbitraryLoads</key>');
  });
});
