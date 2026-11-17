/**
 * Social apps' in-app browsers (WebViews inside Instagram, TikTok, Facebook…): file sharing
 * and downloads often don't work there. Telegram and WhatsApp open links in full Safari/Chrome,
 * so they are left alone.
 */
const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|TikTok|musical_ly|BytedanceWebview|Snapchat|LinkedInApp|\bLine\//i;

export const isInAppBrowser = (ua: string) => IN_APP.test(ua);
export const isAndroid = (ua: string) => /Android/i.test(ua);

/** Android intent URL that opens the current page in Chrome (works from most apps' WebViews). */
export function chromeIntentUrl(href: string): string {
  const u = new URL(href);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
}
