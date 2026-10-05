import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';

// Ask for a Play Store rating once the user has gotten value from the app:
// after their Nth successful manual AI Audit. Play decides whether the sheet
// actually appears (it enforces its own quota), so we only ask once and never
// show our own "rate us" UI or ask about sentiment first, per Play's in-app
// review guidelines.
const COUNT_KEY = 'wealthsense_audit_count_v1';
const ASKED_KEY = 'wealthsense_review_asked_v1';
const AUDITS_BEFORE_ASKING = 3;

export const recordSuccessfulAudit = () => {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    const count = Number(localStorage.getItem(COUNT_KEY) || 0) + 1;
    localStorage.setItem(COUNT_KEY, String(count));
    if (count < AUDITS_BEFORE_ASKING) return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    return; // storage blocked: skip rather than risk asking repeatedly
  }
  // Let the results render and scroll into view before the sheet slides up.
  setTimeout(() => {
    InAppReview.requestReview().catch(error => console.warn('In-app review unavailable:', error));
  }, 2500);
};
