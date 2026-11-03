import { WebPlugin } from '@capacitor/core';

import type {
  BackgroundUploadState,
  DiscoverLanAppliancesResult,
  LocalHubPlugin,
  LocalHubSecureGetResult,
  LocalHubStartResult,
  LocalHubStatusResult,
  NativeCurrentLocation,
  NativeLocationAuthorization,
} from './definitions';

/**
 * Web/no-op implementation. There is no embedded HTTP server in a browser tab, so
 * `start()` reports unavailable and status always reads "not running". This exists only
 * to satisfy `registerPlugin`'s web fallback contract for environments (Storybook, unit
 * tests, `cap run` in a browser tab) that might otherwise throw "not implemented" instead
 * of a clear, intentional error.
 */
export class LocalHubWeb extends WebPlugin implements LocalHubPlugin {
  async start(): Promise<LocalHubStartResult> {
    throw this.unavailable('LocalHub is only available in the native app.');
  }

  async stop(): Promise<void> {
    // Nothing running on web -- no-op.
  }

  async getStatus(): Promise<LocalHubStatusResult> {
    return { running: false };
  }

  /**
   * The secure store is `unavailable`, not silently backed by `localStorage`. A browser has
   * no keystore, and quietly answering from `localStorage` here would let a caller believe
   * a value was protected when it is readable by any script on the origin — the same class
   * of lie this store was built to remove. `@ci/common`'s `secureStorageGet` picks the
   * `localStorage` fallback explicitly, on the web path, where that trade-off is visible.
   */
  async secureGet(): Promise<LocalHubSecureGetResult> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }

  async secureSet(): Promise<void> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }

  async secureRemove(): Promise<void> {
    throw this.unavailable('LocalHub secure storage is only available in the native app.');
  }

  async openUrl(): Promise<void> {
    throw this.unavailable('LocalHub openUrl is only available in the native app.');
  }

  async startAuthSession(): Promise<void> {
    throw this.unavailable('LocalHub startAuthSession is only available in the iOS app.');
  }

  async getCurrentLocation(): Promise<NativeCurrentLocation> {
    throw this.unavailable('Current location is only available in the iOS app.');
  }

  async openAppSettings(): Promise<void> {
    throw this.unavailable('App Settings is only available in the native app.');
  }

  async getLocationAuthorization(): Promise<{ status: NativeLocationAuthorization }> {
    return { status: 'unsupported' };
  }

  async requestLocationAuthorization(): Promise<{ status: NativeLocationAuthorization }> {
    return { status: 'unsupported' };
  }

  async startSignificantLocationUpdates(): Promise<void> {
    // Browsers have no significant-change service. The web watcher uses geolocation.
  }

  async stopSignificantLocationUpdates(): Promise<void> {
    // Nothing started on web.
  }

  async getBackgroundUpload(): Promise<BackgroundUploadState> {
    return { enabled: false, supported: false };
  }

  async setBackgroundUpload(): Promise<BackgroundUploadState> {
    // No queue of native fixes to upload in a browser.
    return { enabled: false, supported: false };
  }

  // A browser keeps no replica, so there is nothing to sync in the background.
  async configureBackgroundSync(): Promise<void> {}

  async claimReplica(): Promise<{ free: boolean }> {
    return { free: true };
  }

  async releaseReplica(): Promise<void> {}

  async clearBackgroundSync(): Promise<void> {}

  async discoverLanAppliances(): Promise<DiscoverLanAppliancesResult> {
    // Browsers cannot perform raw UDP mDNS discovery; callers fall back to manual URL entry.
    return { appliances: [], supported: false };
  }
}
