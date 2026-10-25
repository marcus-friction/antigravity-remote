import { Platform } from 'react-native';
import {
  ANDROID_CHROME_USER_AGENT,
  IOS_SAFARI_USER_AGENT,
} from '../constants/config';

/**
 * Returns a clean, platform-matched mobile browser User-Agent string
 * that avoids Google's `403: disallowed_useragent` block on embedded WebViews.
 */
export function getCleanMobileUserAgent(os: string = Platform.OS): string {
  if (os === 'ios') {
    return IOS_SAFARI_USER_AGENT;
  }
  return ANDROID_CHROME_USER_AGENT;
}

/**
 * Sanitizes an arbitrary Android or iOS WebView User-Agent string by stripping
 * embedded WebView markers (`; wv` and `Version/4.0`).
 */
export function stripWebViewMarkers(rawUserAgent: string): string {
  if (!rawUserAgent || typeof rawUserAgent !== 'string') {
    return getCleanMobileUserAgent();
  }
  return rawUserAgent
    .replace(/;\s*wv\b/gi, '')
    .replace(/\bVersion\/\d+\.\d+\s+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
