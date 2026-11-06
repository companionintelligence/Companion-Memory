import en from '@ci/common/i18n/translations/en.json';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

// Guards on the i18next singleton rather than a module-local flag: Storybook and
// the app can end up with separate copies of this module but share the instance.

/**
 * Initialise the shared i18next instance.
 *
 * Mirrors CI-Hub's setup (i18next + react-i18next + browser language detection,
 * flat SCREAMING_SNAKE keys in a single `translation` namespace, `en.json` as the
 * Crowdin source) with one deliberate difference: `en` is bundled and init is
 * synchronous, so `t()` resolves on the first render and in tests without a
 * provider. Hub blocks its first paint on an HTTP fetch because it ships 30
 * locales; we ship one. When more locales land, add `i18next-http-backend` with
 * `partialBundledLanguages: true` and serve them from the API, as Hub does.
 *
 * Idempotent — safe to call from both the app entrypoint and the test setup.
 */
export function initI18n(): typeof i18n {
  if (i18n.isInitialized) {
    return i18n;
  }

  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        'en-US': { translation: en },
      },
      fallbackLng: 'en',
      // Safe while `en` is the only locale: a fr-FR browser resolves the
      // hierarchy ['fr-FR', 'en'] and lands on English. It becomes wrong the
      // moment a regional file ships — fr.json would NOT match a fr-FR browser
      // under `currentOnly`. Switch to 'languageOnly' when adding locales.
      load: 'currentOnly',
      // i18next otherwise defers the tail of init to a setTimeout, which would make
      // the synchronous guarantee above merely usually-true: the first render could
      // paint raw KEYs, and tests would depend on timing. Resources are bundled, so
      // there is nothing to wait for.
      initAsync: false,
      react: { useSuspense: false },
      // React already escapes interpolated values; escaping again double-encodes
      // apostrophes and quotes in names that flow through {{...}} placeholders.
      interpolation: { escapeValue: false },
    });

  return i18n;
}

export { i18n };
