import { Capacitor } from '@capacitor/core';
import { AdMob, AdmobConsentStatus, BannerAdPluginEvents, BannerAdPosition, BannerAdSize } from '@capacitor-community/admob';

// Google's public test banner unit. Set VITE_ADMOB_BANNER_ID to the real
// "Bottom Banner" unit for release builds. Ad unit IDs ship inside the app by
// design, so this isn't a secret — it's only kept out of git to avoid
// accidentally serving real ads (and invalid clicks) from dev builds.
const TEST_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';
const BANNER_ID = import.meta.env.VITE_ADMOB_BANNER_ID || TEST_BANNER_ID;
const IS_TESTING = BANNER_ID === TEST_BANNER_ID;

// Hashed IDs of our own phones (comma-separated), from the "setTestDeviceIds"
// hint the Ads SDK logs on first launch. They get labelled test ads even with
// the real ad unit, so we never click our own live ads.
const TEST_DEVICE_IDS = (import.meta.env.VITE_ADMOB_TEST_DEVICE_IDS || '')
  .split(',').map(id => id.trim()).filter(Boolean);

// The banner is drawn natively on top of the WebView, so we expose its height
// as a CSS variable for the layout to reserve space at the bottom.
const setAdHeight = (px: number) => {
  document.documentElement.style.setProperty('--ad-height', `${px}px`);
};

export const initAds = async () => {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await AdMob.initialize({
      initializeForTesting: IS_TESTING || TEST_DEVICE_IDS.length > 0,
      testingDevices: TEST_DEVICE_IDS,
    });

    // Google's UMP consent flow: shows the GDPR/US-state privacy form only
    // where the user's region requires it. If the consent service itself
    // can't be reached (it errors for a while on newly created AdMob apps),
    // fall back to non-personalized ads rather than showing none.
    let nonPersonalized = false;
    try {
      let consent = await AdMob.requestConsentInfo();
      if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
        consent = await AdMob.showConsentForm();
      }
      if (!consent.canRequestAds) return;
    } catch (error) {
      console.warn('AdMob consent check failed, using non-personalized ads:', error);
      nonPersonalized = true;
    }

    await AdMob.addListener(BannerAdPluginEvents.SizeChanged, size => setAdHeight(size.height));
    await AdMob.addListener(BannerAdPluginEvents.FailedToLoad, () => setAdHeight(0));

    await AdMob.showBanner({
      adId: BANNER_ID,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: 0,
      isTesting: IS_TESTING,
      npa: nonPersonalized,
    });
  } catch (error) {
    // Ads must never take the app down.
    console.error('AdMob init failed:', error);
    setAdHeight(0);
  }
};
