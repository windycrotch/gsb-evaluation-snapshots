import { describe, expect, it } from 'vitest';
import { chromeIntentUrl, isInAppBrowser } from './inapp';

describe('in-app browsers', () => {
  it('detects Instagram/TikTok/Facebook, ignores Safari, Chrome and Telegram', () => {
    expect(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit Mobile Instagram 300.0')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari [FB_IAB/FB4A;FBAV/450]')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) musical_ly_2023 BytedanceWebview')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36')).toBe(false);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 Telegram-Android/11.0')).toBe(false);
  });

  it('Chrome intent URL keeps path and query', () => {
    expect(chromeIntentUrl('https://pleasejusttext.me/?lang=ru')).toBe(
      'intent://pleasejusttext.me/?lang=ru#Intent;scheme=https;package=com.android.chrome;end',
    );
  });
});
