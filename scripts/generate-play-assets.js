#!/usr/bin/env node
/**
 * Deterministic Google Play Store visual asset generator for Antigravity Remote.
 *
 * Uses local headless Chromium for branding. Screenshots come from native Android
 * captures with local sample data, recorded in store-assets/screenshots/capture-manifest.json.
 * Pixel 10 Pro originals remain 1280x2856; Play exports add plain side gutters to
 * satisfy the existing 2:1 store asset bounds without resizing the captured UI.
 *   - icon/play-icon-512.png                      (512x512)
 *   - feature-graphic/feature-graphic-1024x500.png (1024x500)
 *   - phone-screenshots/1.png .. 6.png            (1428x2856)
 *   - tablet-screenshots/1.png .. 3.png           (1728x1080, 7-inch tablet)
 *   - large-tablet-screenshots/1.png .. 3.png     (1920x1200, 10-inch tablet)
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const GRAPHICS_DIR = path.join(
  ROOT,
  'android/app/src/main/play/listings/en-US/graphics',
);
const APP_ICON_PATH = path.join(ROOT, 'assets/icon.png');

const THEME = {
  canvas: '#0B0B0E',
  sidebar: '#111114',
  well: '#0D0D11',
  surface: '#16161B',
  surfaceRaised: '#1C1C22',
  surfaceSelected: '#1F2028',
  control: '#24252A',
  borderSubtle: 'rgba(255, 255, 255, 0.06)',
  border: 'rgba(255, 255, 255, 0.09)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',
  textPrimary: '#F4F5F7',
  textSecondary: '#BCBDC6',
  textMuted: '#87888F',
  textPlaceholder: '#636470',
  primary: '#2F71E3',
  primaryBright: '#3279F9',
  primaryText: '#8AB4F8',
  primarySoft: 'rgba(47, 113, 227, 0.16)',
  primaryBorder: 'rgba(138, 180, 248, 0.42)',
  approval: '#F59E0B',
  approvalText: '#FDE68A',
  approvalSoft: 'rgba(245, 158, 11, 0.15)',
  approvalBorder: 'rgba(245, 158, 11, 0.42)',
  error: '#EF4444',
  errorText: '#FECACA',
  errorSoft: 'rgba(222, 85, 85, 0.16)',
  errorBorder: 'rgba(239, 68, 68, 0.42)',
  unread: '#3279F9',
  unreadText: '#BFDBFE',
  unreadSoft: 'rgba(50, 121, 249, 0.18)',
  unreadBorder: 'rgba(138, 180, 248, 0.44)',
  running: '#34D399',
  runningSolid: '#10B981',
  runningText: '#A7F3D0',
  runningSoft: 'rgba(52, 211, 153, 0.14)',
  runningBorder: 'rgba(52, 211, 153, 0.36)',
};

function findChromiumBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (bin.includes(path.sep)) {
        if (fs.existsSync(bin)) return bin;
      } else {
        const resolved = execFileSync('which', [bin], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (resolved) return resolved;
      }
    } catch {
      // Try next candidate
    }
  }
  throw new Error(
    'Headless Chromium/Chrome binary not found. Install chromium or set CHROME_BIN.',
  );
}

const ICON_DATA_URI = `data:image/png;base64,${fs
  .readFileSync(APP_ICON_PATH)
  .toString('base64')}`;

const FONT_STACK =
  '"Noto Sans", "DejaVu Sans", "Liberation Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO_STACK =
  '"DejaVu Sans Mono", "Liberation Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const SVG_ICONS = {
  folder: (size = 13, color = '#BCBDC6') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.2L7.7 4.7H12.5C13.33 4.7 14 5.37 14 6.2V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"/></svg>`,
  search: (size = 17, color = '#87888F') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.5 13.5L17 17"/></svg>`,
  refresh: (size = 17, color = '#87888F') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16.2 10A6.2 6.2 0 1 1 14.3 5.5"/><path d="M14.5 2.8V5.8H11.5"/></svg>`,
  chevronDown: (size = 12, color = '#87888F') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6L8 10L12 6"/></svg>`,
  chevronRight: (size = 12, color = '#87888F') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L10 8L6 12"/></svg>`,
  inbox: (color) =>
    `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5L5.2 4.5H14.8L17 11.5V15.5C17 16.33 16.33 17 15.5 17H4.5C3.67 17 3 16.33 3 15.5V11.5Z"/><path d="M3 11.5H7.2L8.4 13.5H11.6L12.8 11.5H17"/></svg>`,
  projects: (color) =>
    `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5C2.5 4.4 3.4 3.5 4.5 3.5H7.8L9.6 5.5H15.5C16.6 5.5 17.5 6.4 17.5 7.5V14.5C17.5 15.6 16.6 16.5 15.5 16.5H4.5C3.4 16.5 2.5 15.6 2.5 14.5V5.5Z"/></svg>`,
  usage: (color) =>
    `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15.5V10.5"/><path d="M10 15.5V5.5"/><path d="M16 15.5V8.5"/></svg>`,
  settings: (color) =>
    `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.7"/><path d="M10 3V5M10 15V17M3 10H5M15 10H17M5.1 5.1L6.5 6.5M13.5 13.5L14.9 14.9M14.9 5.1L13.5 6.5M6.5 13.5L5.1 14.9"/></svg>`,
  back: (color = '#BCBDC6') =>
    `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5L7 10L12.5 15.5"/></svg>`,
  wifi: () =>
    `<svg width="18" height="14" viewBox="0 0 24 18" fill="#F4F5F7"><path d="M12 14.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-4.5-3.1 1.7 1.7a4.5 4.5 0 0 1 5.6 0l1.7-1.7a7 7 0 0 0-9 0zm-3.6-3.6 1.7 1.7a9.5 9.5 0 0 1 12.8 0l1.7-1.7a12 12 0 0 0-16.2 0z"/></svg>`,
  signal: () =>
    `<svg width="16" height="14" viewBox="0 0 16 14" fill="#F4F5F7"><rect x="1" y="9" width="2.4" height="4" rx="0.6"/><rect x="5" y="6.5" width="2.4" height="6.5" rx="0.6"/><rect x="9" y="4" width="2.4" height="9" rx="0.6"/><rect x="13" y="1" width="2.4" height="12" rx="0.6"/></svg>`,
  battery: () =>
    `<svg width="24" height="13" viewBox="0 0 24 13" fill="none"><rect x="0.8" y="1.2" width="19.5" height="10.6" rx="2.5" stroke="#F4F5F7" stroke-width="1.4"/><rect x="2.8" y="3.2" width="14.5" height="6.6" rx="1.2" fill="#F4F5F7"/><rect x="21.4" y="4.2" width="2" height="4.6" rx="1" fill="#F4F5F7"/></svg>`,
  agyMono: (size = 16, color = '#FFFFFF') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}"><path d="M12 3.2C9.2 3.2 7.8 9.2 5.4 17.6C4.8 19.6 6.2 20.8 7.6 19.8C9.2 18.6 10.3 15.6 12 15.6C13.7 15.6 14.8 18.6 16.4 19.8C17.8 20.8 19.2 19.6 18.6 17.6C16.2 9.2 14.8 3.2 12 3.2Z"/></svg>`,
  send: () =>
    `<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.5V4.5"/><path d="M5.5 9L10 4.5L14.5 9"/></svg>`,
  terminal: (color = '#FDE68A') =>
    `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5L7 8.5L4.5 10.5"/><path d="M8.5 10.5H11.5"/></svg>`,
  lock: () =>
    `<svg width="16" height="18" viewBox="0 0 16 18" fill="none" stroke="#BCBDC6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8" width="11" height="8" rx="2"/><path d="M5 8V5.5A3 3 0 0 1 11 5.5V8"/></svg>`,
  grid: (size = 17, color = '#BCBDC6') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="5.5" height="5.5" rx="1.4"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.4"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.4"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.4"/></svg>`,
  link: (size = 17, color = '#8AB4F8') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5L11.5 8.5"/><path d="M11 6.5L12.6 4.9A3.1 3.1 0 0 1 17 9.3L15.4 10.9"/><path d="M9 13.5L7.4 15.1A3.1 3.1 0 0 1 3 10.7L4.6 9.1"/></svg>`,
  checkCircle: (size = 15, color = '#34D399') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.1L7.1 9.8L10.8 6.1"/></svg>`,
};

const COMMON_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #07080B;
  color: ${THEME.textPrimary};
  font-family: ${FONT_STACK};
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.studio-canvas {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(ellipse 82% 46% at 50% -6%, rgba(47, 113, 227, 0.22), transparent 70%),
    radial-gradient(ellipse 56% 36% at 88% 92%, rgba(245, 158, 11, 0.08), transparent 72%),
    linear-gradient(180deg, #090B10 0%, #07080B 100%);
}
.studio-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 90% 80% at 50% 35%, black 20%, transparent 85%);
  pointer-events: none;
}
.phone-header {
  position: relative;
  z-index: 2;
  text-align: center;
  padding: 58px 64px 34px;
  flex-shrink: 0;
}
.phone-title {
  font-size: 52px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.12;
  color: #FFFFFF;
}
.phone-subtitle {
  margin-top: 14px;
  font-size: 27px;
  font-weight: 500;
  line-height: 1.32;
  color: #A1A5B5;
}
.phone-frame {
  position: relative;
  z-index: 2;
  width: 896px;
  flex: 1;
  margin-bottom: -24px;
  border-radius: 56px 56px 0 0;
  padding: 14px 14px 0 14px;
  background: linear-gradient(160deg, #2D303A 0%, #17181F 45%, #23252F 100%);
  box-shadow:
    0 34px 90px rgba(0, 0, 0, 0.75),
    0 0 0 1px rgba(255, 255, 255, 0.14) inset;
  display: flex;
  flex-direction: column;
}
.phone-screen {
  width: 100%;
  flex: 1;
  border-radius: 44px 44px 0 0;
  background: ${THEME.canvas};
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.status-bar {
  height: 54px;
  padding: 0 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 19px;
  font-weight: 600;
  color: ${THEME.textPrimary};
  flex-shrink: 0;
  position: relative;
  z-index: 20;
}
.camera-punch {
  position: absolute;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #020203;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.06);
}
.status-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gesture-bar {
  position: absolute;
  bottom: 36px;
  left: 50%;
  transform: translateX(-50%);
  width: 220px;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.55);
  z-index: 40;
}

/* Tablet studio framing */
.tablet-header {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 34px 72px 24px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 32px;
  flex-shrink: 0;
}
.tablet-title {
  font-size: 40px;
  font-weight: 800;
  letter-spacing: -0.025em;
  color: #FFFFFF;
}
.tablet-subtitle {
  font-size: 22px;
  font-weight: 500;
  color: #A1A5B5;
}
.tablet-frame {
  position: relative;
  z-index: 2;
  width: calc(100% - 112px);
  flex: 1;
  margin-bottom: 34px;
  border-radius: 34px;
  padding: 13px;
  background: linear-gradient(155deg, #2C2F3A 0%, #15161D 50%, #232630 100%);
  box-shadow:
    0 32px 84px rgba(0, 0, 0, 0.78),
    0 0 0 1px rgba(255, 255, 255, 0.14) inset;
  display: flex;
  flex-direction: column;
}
.tablet-screen {
  width: 100%;
  flex: 1;
  border-radius: 23px;
  background: ${THEME.canvas};
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.tablet-split {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* Shared Onyx Drawer Components */
.drawer-panel {
  background: ${THEME.sidebar};
  border-right: 1px solid ${THEME.border};
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
  z-index: 10;
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  gap: 10px;
}
.machine-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-radius: 999px;
  background: ${THEME.surfaceRaised};
  border: 1px solid ${THEME.border};
  font-size: 18px;
  font-weight: 600;
  color: ${THEME.textPrimary};
  max-width: 72%;
}
.machine-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${THEME.running};
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.65);
  flex-shrink: 0;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.borderSubtle};
  display: flex;
  align-items: center;
  justify-content: center;
}
.filter-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border-bottom: 1px solid ${THEME.borderSubtle};
  flex-shrink: 0;
}
.filter-tabs {
  display: flex;
  align-items: center;
  gap: 20px;
}
.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 11px 2px 12px;
  font-size: 16px;
  font-weight: 600;
  color: ${THEME.textMuted};
  border-bottom: 2.5px solid transparent;
}
.filter-tab.active {
  color: ${THEME.textPrimary};
  border-bottom-color: ${THEME.primaryBright};
}
.tab-count {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  background: rgba(255,255,255,0.06);
  color: ${THEME.textMuted};
}
.filter-tab.active .tab-count {
  background: ${THEME.primarySoft};
  color: ${THEME.primaryText};
}
.inline-link-btn {
  font-size: 14px;
  font-weight: 600;
  color: ${THEME.primaryText};
  padding: 6px 10px;
  border-radius: 8px;
  background: ${THEME.primarySoft};
  border: 1px solid rgba(138,180,248,0.22);
}
.drawer-scroll {
  flex: 1;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}
.thread-card {
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  border-left-width: 4.5px;
  border-radius: 13px;
  padding: 14px 15px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.thread-card.active-card {
  background: ${THEME.surfaceSelected};
  border-color: ${THEME.primaryBorder};
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.badges-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.kind-badge {
  padding: 3px 9px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
  border: 1px solid transparent;
}
.open-badge {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.05em;
  background: ${THEME.primarySoft};
  border: 1px solid ${THEME.primaryBorder};
  color: ${THEME.primaryText};
}
.card-time {
  font-size: 13px;
  font-weight: 500;
  color: ${THEME.textMuted};
}
.project-eyebrow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: ${THEME.textSecondary};
  margin-top: 2px;
}
.thread-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.28;
  color: ${THEME.textPrimary};
}
.thread-reason {
  font-size: 14.5px;
  font-weight: 500;
  line-height: 1.32;
}
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 3px;
}
.meta-host {
  font-size: 13.5px;
  font-weight: 500;
  color: ${THEME.textMuted};
}
.mark-read-chip {
  padding: 4px 11px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  border: 1px solid ${THEME.borderStrong};
  font-size: 12.5px;
  font-weight: 600;
  color: ${THEME.textSecondary};
}
.bottom-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 12px 10px 64px;
  background: ${THEME.well};
  border-top: 1px solid ${THEME.border};
  flex-shrink: 0;
}
.bottom-mode-bar.tablet-bar {
  padding: 10px 8px 14px;
}
.mode-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  position: relative;
  min-width: 72px;
}
.mode-label {
  font-size: 13.5px;
  font-weight: 600;
  color: ${THEME.textMuted};
}
.mode-label.active {
  color: ${THEME.primaryText};
}
.mode-badge {
  position: absolute;
  top: -5px;
  right: 8px;
  min-width: 21px;
  height: 21px;
  padding: 0 6px;
  border-radius: 999px;
  background: ${THEME.approval};
  color: #111114;
  font-size: 12px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Projects View */
.projects-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  border-bottom: 1px solid ${THEME.borderSubtle};
  font-size: 14.5px;
  font-weight: 600;
  color: ${THEME.textMuted};
}
.projects-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.add-proj-btn {
  padding: 6px 12px;
  border-radius: 8px;
  background: ${THEME.primary};
  color: #FFFFFF;
  font-size: 14px;
  font-weight: 700;
}
.project-group {
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  border-radius: 14px;
  overflow: hidden;
}
.project-group.active-group {
  border-color: ${THEME.primaryBorder};
}
.project-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 14px;
  gap: 10px;
}
.project-group-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.project-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  color: ${THEME.textPrimary};
}
.project-sub {
  margin-top: 2px;
  font-size: 13.5px;
  color: ${THEME.textMuted};
}
.proj-badge {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
}
.proj-new-btn {
  padding: 6px 12px;
  border-radius: 9px;
  background: ${THEME.control};
  border: 1px solid ${THEME.borderStrong};
  color: ${THEME.textPrimary};
  font-size: 13.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.project-tray {
  border-top: 1px solid ${THEME.borderSubtle};
  background: rgba(11, 11, 14, 0.45);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.project-thread-card {
  background: ${THEME.surfaceRaised};
  border: 1px solid ${THEME.borderSubtle};
  border-left-width: 4px;
  border-radius: 10px;
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* Usage View */
.usage-section-title {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: ${THEME.textMuted};
  margin: 6px 2px 2px;
}
.usage-card {
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.usage-plan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.tier-pill {
  padding: 4px 11px;
  border-radius: 999px;
  background: ${THEME.primarySoft};
  border: 1px solid ${THEME.primaryBorder};
  color: ${THEME.primaryText};
  font-size: 13.5px;
  font-weight: 700;
}
.credit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid ${THEME.borderSubtle};
  font-size: 15.5px;
}
.quota-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.quota-item + .quota-item {
  padding-top: 11px;
  border-top: 1px solid ${THEME.borderSubtle};
}
.quota-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.quota-label {
  font-size: 16px;
  font-weight: 600;
  color: ${THEME.textPrimary};
  display: flex;
  align-items: center;
  gap: 8px;
}
.default-tag {
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 800;
  background: rgba(255,255,255,0.08);
  color: ${THEME.textSecondary};
}
.pct-pill {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 700;
  border: 1px solid transparent;
}
.progress-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 999px;
}
.quota-reset {
  font-size: 13px;
  color: ${THEME.textMuted};
}
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.metric-tile {
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  border-radius: 13px;
  padding: 13px 10px;
  text-align: center;
}
.metric-val {
  font-size: 24px;
  font-weight: 800;
  color: ${THEME.textPrimary};
}
.metric-lbl {
  margin-top: 3px;
  font-size: 13px;
  color: ${THEME.textMuted};
}

/* Settings View */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.settings-label {
  font-size: 17px;
  font-weight: 700;
  color: ${THEME.textPrimary};
}
.settings-desc {
  font-size: 14px;
  line-height: 1.38;
  color: ${THEME.textMuted};
}
.chip-row {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
}
.chip {
  flex: 1;
  text-align: center;
  padding: 10px 8px;
  border-radius: 10px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  font-size: 14.5px;
  font-weight: 600;
  color: ${THEME.textSecondary};
}
.chip.selected {
  background: ${THEME.primarySoft};
  border-color: ${THEME.primaryBorder};
  color: ${THEME.primaryText};
}
.settings-hint {
  font-size: 13.5px;
  color: ${THEME.textSecondary};
}
.settings-divider {
  height: 1px;
  background: ${THEME.borderSubtle};
  margin: 4px 0;
}
.action-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 11px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.border};
  font-size: 15.5px;
  font-weight: 600;
  color: ${THEME.textPrimary};
}
.handoff-box {
  background: ${THEME.well};
  border: 1px solid ${THEME.primaryBorder};
  border-radius: 11px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.handoff-input-row {
  display: flex;
  gap: 8px;
}
.handoff-input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 9px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.borderStrong};
  color: ${THEME.textPrimary};
  font-family: ${MONO_STACK};
  font-size: 13.5px;
}
.go-btn {
  padding: 10px 18px;
  border-radius: 9px;
  background: ${THEME.primary};
  color: #FFFFFF;
  font-size: 15px;
  font-weight: 700;
}
.signout-btn {
  padding: 13px;
  border-radius: 11px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.34);
  color: #FCA5A5;
  text-align: center;
  font-size: 15.5px;
  font-weight: 700;
}

/* Antigravity Workspace Chat Pane */
.workspace-pane {
  flex: 1;
  background: ${THEME.canvas};
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}
.ws-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid ${THEME.borderSubtle};
  background: #0E0E12;
  flex-shrink: 0;
}
.ws-header-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ws-project-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: ${THEME.textMuted};
}
.ws-thread-title {
  font-size: 19px;
  font-weight: 700;
  color: ${THEME.textPrimary};
}
.ws-body {
  flex: 1;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow: hidden;
}
.user-bubble {
  align-self: flex-end;
  max-width: 82%;
  padding: 13px 17px;
  border-radius: 16px 16px 4px 16px;
  background: #1B2436;
  border: 1px solid rgba(138, 180, 248, 0.25);
  font-size: 16px;
  line-height: 1.45;
  color: ${THEME.textPrimary};
}
.agent-block {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.thought-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 6px 12px;
  border-radius: 999px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.borderSubtle};
  font-size: 13.5px;
  color: ${THEME.textMuted};
}
.agent-text {
  font-size: 16.5px;
  line-height: 1.5;
  color: #E2E4EC;
}
.diff-card {
  background: #121318;
  border: 1px solid ${THEME.border};
  border-radius: 12px;
  overflow: hidden;
  font-family: ${MONO_STACK};
  font-size: 13.5px;
}
.diff-header {
  display: flex;
  justify-content: space-between;
  padding: 9px 14px;
  background: #181920;
  border-bottom: 1px solid ${THEME.borderSubtle};
  color: ${THEME.textSecondary};
  font-family: ${FONT_STACK};
  font-size: 13.5px;
  font-weight: 600;
}
.diff-line {
  padding: 5px 14px;
  white-space: pre;
}
.diff-add { background: rgba(16, 185, 129, 0.13); color: #A7F3D0; }
.diff-ctx { color: #9DA1B0; }
.approval-box {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.12) 0%, #17161B 100%);
  border: 1px solid ${THEME.approvalBorder};
  border-left: 4px solid ${THEME.approval};
  border-radius: 13px;
  padding: 15px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.approval-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.approval-cmd {
  padding: 10px 13px;
  border-radius: 9px;
  background: #0D0D11;
  border: 1px solid ${THEME.border};
  font-family: ${MONO_STACK};
  font-size: 14.5px;
  color: #FDE68A;
}
.approval-btns {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.btn-reject {
  padding: 9px 18px;
  border-radius: 9px;
  background: ${THEME.control};
  border: 1px solid ${THEME.borderStrong};
  color: ${THEME.textSecondary};
  font-size: 14.5px;
  font-weight: 700;
}
.btn-allow {
  padding: 9px 20px;
  border-radius: 9px;
  background: ${THEME.primary};
  color: #FFFFFF;
  font-size: 14.5px;
  font-weight: 700;
}
.composer-bar {
  padding: 14px 20px 64px;
  border-top: 1px solid ${THEME.borderSubtle};
  background: #0E0E12;
  flex-shrink: 0;
}
.composer-bar.tablet-composer {
  padding: 14px 22px 18px;
}
.composer-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 18px;
  border-radius: 16px;
  background: ${THEME.surface};
  border: 1px solid ${THEME.borderStrong};
  color: ${THEME.textPlaceholder};
  font-size: 16px;
}
.send-btn {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: ${THEME.primary};
  display: flex;
  align-items: center;
  justify-content: center;
}
.left-edge-handle {
  position: absolute;
  left: 0;
  top: 74%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 25;
}
.handle-line {
  width: 6px;
  height: 82px;
  border-radius: 0 6px 6px 0;
  background: ${THEME.approval};
  box-shadow: 0 0 14px rgba(245, 158, 11, 0.55);
}
.handle-pill {
  padding: 4px 9px;
  border-radius: 999px;
  background: ${THEME.approval};
  color: #111114;
  font-size: 13px;
  font-weight: 800;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
`;

function statusBarHtml(time = '10:24', compact = false) {
  return `
  <div class="status-bar" style="${compact ? 'height: 38px; font-size: 15px; padding: 0 22px;' : ''}">
    <span>${time}</span>
    ${compact ? '' : '<div class="camera-punch"></div>'}
    <div class="status-right">
      ${SVG_ICONS.wifi()}
      ${SVG_ICONS.signal()}
      ${SVG_ICONS.battery()}
    </div>
  </div>`;
}

function bottomModeBarHtml(active, tablet = false) {
  const items = [
    { key: 'inbox', label: 'Inbox', icon: SVG_ICONS.inbox, badge: '3' },
    { key: 'projects', label: 'Projects', icon: SVG_ICONS.projects },
    { key: 'usage', label: 'Usage', icon: SVG_ICONS.usage },
    { key: 'settings', label: 'Settings', icon: SVG_ICONS.settings },
  ];
  return `
  <div class="bottom-mode-bar ${tablet ? 'tablet-bar' : ''}">
    ${items
      .map((it) => {
        const isAct = it.key === active;
        const color = isAct ? THEME.primaryText : THEME.textMuted;
        return `
        <div class="mode-btn">
          ${it.badge ? `<div class="mode-badge">${it.badge}</div>` : ''}
          ${it.icon(color)}
          <span class="mode-label ${isAct ? 'active' : ''}">${it.label}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function renderInboxCardHtml({
  kind,
  badge,
  isOpen = false,
  time,
  project,
  title,
  reason,
  host,
  markRead = false,
}) {
  const stylesByKind = {
    approval: {
      accent: THEME.approval,
      bg: THEME.approvalSoft,
      border: THEME.approvalBorder,
      text: THEME.approvalText,
      reasonColor: THEME.approvalText,
    },
    unread: {
      accent: THEME.unread,
      bg: THEME.unreadSoft,
      border: THEME.unreadBorder,
      text: THEME.unreadText,
      reasonColor: THEME.unreadText,
    },
    error: {
      accent: THEME.error,
      bg: THEME.errorSoft,
      border: THEME.errorBorder,
      text: THEME.errorText,
      reasonColor: THEME.errorText,
    },
    running: {
      accent: THEME.runningSolid,
      bg: THEME.runningSoft,
      border: THEME.runningBorder,
      text: THEME.runningText,
      reasonColor: THEME.runningText,
    },
    idle: {
      accent: '#525461',
      bg: 'rgba(255, 255, 255, 0.06)',
      border: 'rgba(255, 255, 255, 0.12)',
      text: THEME.textSecondary,
      reasonColor: THEME.textMuted,
    },
  };
  const st = stylesByKind[kind];
  return `
  <div class="thread-card ${isOpen ? 'active-card' : ''}" style="border-left-color: ${st.accent};">
    <div class="card-top">
      <div class="badges-row">
        <span class="kind-badge" style="background:${st.bg};border-color:${st.border};color:${st.text};">${badge}</span>
        ${isOpen ? '<span class="open-badge">OPEN</span>' : ''}
      </div>
      <span class="card-time">${time}</span>
    </div>
    ${
      project
        ? `<div class="project-eyebrow">${SVG_ICONS.folder(14, THEME.textSecondary)}<span>${project}</span></div>`
        : ''
    }
    <div class="thread-title">${title}</div>
    <div class="thread-reason" style="color:${st.reasonColor};">${reason}</div>
    <div class="card-footer">
      <span class="meta-host">${host}</span>
      ${markRead ? '<span class="mark-read-chip">Mark read</span>' : ''}
    </div>
  </div>`;
}

function inboxDrawerHtml({ widthStyle, tablet = false }) {
  return `
  <div class="drawer-panel" style="${widthStyle}">
    <div class="drawer-header">
      <div class="machine-pill">
        <span class="machine-dot"></span>
        <span>Mac Studio</span>
        ${SVG_ICONS.chevronDown(14, THEME.textMuted)}
      </div>
      <div class="header-actions">
        <div class="icon-btn">${SVG_ICONS.search()}</div>
        <div class="icon-btn">${SVG_ICONS.refresh()}</div>
      </div>
    </div>
    <div class="filter-strip">
      <div class="filter-tabs">
        <div class="filter-tab active">All <span class="tab-count">6</span></div>
        <div class="filter-tab">Attention <span class="tab-count">3</span></div>
        <div class="filter-tab">Running <span class="tab-count">2</span></div>
      </div>
      <div class="inline-link-btn">Read all</div>
    </div>
    <div class="drawer-scroll">
      ${renderInboxCardHtml({
        kind: 'approval',
        badge: 'NEEDS APPROVAL',
        isOpen: true,
        time: 'Just now',
        project: 'backend-api',
        title: 'Deploy production schema migration',
        reason: 'Approve command: npx prisma migrate deploy',
        host: 'Mac Studio',
      })}
      ${renderInboxCardHtml({
        kind: 'unread',
        badge: 'FINISHED',
        time: '2m ago',
        project: 'antigravity-remote',
        title: 'Add docked sidebar for tablets & foldables',
        reason: 'Agent finished — unread updates',
        host: 'Linux Devbox',
        markRead: true,
      })}
      ${renderInboxCardHtml({
        kind: 'error',
        badge: 'NEEDS REVIEW',
        time: '5m ago',
        project: 'billing-worker',
        title: 'Fix Stripe webhook retry idempotency',
        reason: 'Tool execution failed — review stack trace',
        host: 'Mac Studio',
        markRead: true,
      })}
      ${renderInboxCardHtml({
        kind: 'running',
        badge: 'WORKING',
        time: '1m ago',
        project: 'ml-pipeline',
        title: 'Benchmark quantized embedding throughput',
        reason: 'Background task: pytest benchmark suite',
        host: 'GPU Workstation',
      })}
      ${
        tablet
          ? ''
          : renderInboxCardHtml({
              kind: 'idle',
              badge: 'IDLE',
              time: '18m ago',
              project: 'core-storage',
              title: 'Optimize SQLite WAL checkpoint cadence',
              reason: 'Last updated 18m ago — all checks green',
              host: 'Linux Devbox',
            })
      }
    </div>
    ${bottomModeBarHtml('inbox', tablet)}
  </div>`;
}

function projectsDrawerHtml({ widthStyle, tablet = false }) {
  return `
  <div class="drawer-panel" style="${widthStyle}">
    <div class="drawer-header">
      <div class="machine-pill">
        <span class="machine-dot"></span>
        <span>Mac Studio</span>
        ${SVG_ICONS.chevronDown(14, THEME.textMuted)}
      </div>
      <div class="header-actions">
        <div class="icon-btn">${SVG_ICONS.search()}</div>
        <div class="icon-btn">${SVG_ICONS.refresh()}</div>
      </div>
    </div>
    <div class="projects-summary">
      <span>5 projects • 13 threads</span>
      <div class="projects-actions">
        <span class="inline-link-btn" style="background:rgba(255,255,255,0.06);border-color:${THEME.border};color:${THEME.textSecondary};">Collapse all</span>
        <span class="add-proj-btn">+ Project</span>
      </div>
    </div>
    <div class="drawer-scroll" style="${tablet ? 'padding: 11px 14px; gap: 9px;' : ''}">
      <div class="project-group active-group">
        <div class="project-group-header">
          <div class="project-group-left">
            ${SVG_ICONS.chevronDown(14, THEME.primaryText)}
            <div>
              <div class="project-title-line">
                <span>backend-api</span>
                <span class="proj-badge" style="background:${THEME.approval};color:#111114;">1</span>
              </div>
              <div class="project-sub">Mac Studio • 4 threads • Just now</div>
            </div>
          </div>
          <div class="proj-new-btn">+ New</div>
        </div>
        <div class="project-tray">
          <div class="project-thread-card" style="border-left-color:${THEME.approval};background:${THEME.surfaceSelected};border-color:${THEME.primaryBorder};">
            <div class="card-top">
              <div class="badges-row">
                <span class="kind-badge" style="background:${THEME.approvalSoft};border-color:${THEME.approvalBorder};color:${THEME.approvalText};">NEEDS APPROVAL</span>
                <span class="open-badge">OPEN</span>
              </div>
              <span class="card-time">Just now</span>
            </div>
            <div class="thread-title" style="font-size:16.5px;">Deploy production schema migration</div>
            <div class="thread-reason" style="font-size:13.5px;color:${THEME.approvalText};">Approve command: npx prisma migrate deploy</div>
          </div>
          <div class="project-thread-card" style="border-left-color:${THEME.runningSolid};">
            <div class="card-top">
              <span class="kind-badge" style="background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">WORKING</span>
              <span class="card-time">3m ago</span>
            </div>
            <div class="thread-title" style="font-size:16.5px;">Add Redis connection pooling metrics</div>
            <div class="thread-reason" style="font-size:13.5px;color:${THEME.runningText};">Running integration test suite…</div>
          </div>
        </div>
      </div>

      <div class="project-group">
        <div class="project-group-header">
          <div class="project-group-left">
            ${SVG_ICONS.chevronDown(14, THEME.textMuted)}
            <div>
              <div class="project-title-line">
                <span>antigravity-remote</span>
                <span class="proj-badge" style="background:${THEME.unread};color:#FFFFFF;">1</span>
              </div>
              <div class="project-sub">Linux Devbox • 3 threads • 2m ago</div>
            </div>
          </div>
          <div class="proj-new-btn">+ New</div>
        </div>
        <div class="project-tray">
          <div class="project-thread-card" style="border-left-color:${THEME.unread};">
            <div class="card-top">
              <span class="kind-badge" style="background:${THEME.unreadSoft};border-color:${THEME.unreadBorder};color:${THEME.unreadText};">FINISHED</span>
              <span class="card-time">2m ago</span>
            </div>
            <div class="thread-title" style="font-size:16.5px;">Add docked sidebar for tablets &amp; foldables</div>
            <div class="card-footer">
              <span class="thread-reason" style="font-size:13.5px;color:${THEME.unreadText};">Agent finished — unread updates</span>
              <span class="mark-read-chip">Mark read</span>
            </div>
          </div>
        </div>
      </div>

      <div class="project-group">
        <div class="project-group-header">
          <div class="project-group-left">
            ${tablet ? SVG_ICONS.chevronRight(14, THEME.textMuted) : SVG_ICONS.chevronDown(14, THEME.textMuted)}
            <div>
              <div class="project-title-line">
                <span>billing-worker</span>
                <span class="proj-badge" style="background:${THEME.error};color:#FFFFFF;">1</span>
              </div>
              <div class="project-sub">Mac Studio • 2 threads • 5m ago</div>
            </div>
          </div>
          <div class="proj-new-btn">+ New</div>
        </div>
        ${
          tablet
            ? ''
            : `<div class="project-tray">
                <div class="project-thread-card" style="border-left-color:${THEME.error};">
                  <div class="card-top">
                    <span class="kind-badge" style="background:${THEME.errorSoft};border-color:${THEME.errorBorder};color:${THEME.errorText};">NEEDS REVIEW</span>
                    <span class="card-time">5m ago</span>
                  </div>
                  <div class="thread-title" style="font-size:16.5px;">Fix Stripe webhook retry idempotency</div>
                  <div class="card-footer">
                    <span class="thread-reason" style="font-size:13.5px;color:${THEME.errorText};">Tool execution failed — review stack trace</span>
                    <span class="mark-read-chip">Mark read</span>
                  </div>
                </div>
              </div>`
        }
      </div>

      <div class="project-group">
        <div class="project-group-header">
          <div class="project-group-left">
            ${SVG_ICONS.chevronRight(14, THEME.textMuted)}
            <div>
              <div class="project-title-line">
                <span>ml-pipeline</span>
                <span style="width:9px;height:9px;border-radius:50%;background:${THEME.running};display:inline-block;"></span>
              </div>
              <div class="project-sub">GPU Workstation • 2 threads • 1m ago</div>
            </div>
          </div>
          <div class="proj-new-btn">+ New</div>
        </div>
      </div>

      <div class="project-group">
        <div class="project-group-header">
          <div class="project-group-left">
            ${SVG_ICONS.chevronRight(14, THEME.textMuted)}
            <div>
              <div class="project-title-line">
                <span>docs-portal</span>
              </div>
              <div class="project-sub">Linux Devbox • 2 threads • 14m ago</div>
            </div>
          </div>
          <div class="proj-new-btn">+ New</div>
        </div>
      </div>
    </div>
    ${bottomModeBarHtml('projects', tablet)}
  </div>`;
}

function usageDrawerHtml({ widthStyle, tablet = false }) {
  return `
  <div class="drawer-panel" style="${widthStyle}">
    <div class="drawer-header">
      <div class="machine-pill">
        <span class="machine-dot"></span>
        <span>Mac Studio</span>
        ${SVG_ICONS.chevronDown(14, THEME.textMuted)}
      </div>
      <div class="header-actions">
        <span style="font-size:13.5px;color:${THEME.textMuted};margin-right:4px;">Just now</span>
        <div class="icon-btn">${SVG_ICONS.refresh()}</div>
      </div>
    </div>
    <div class="drawer-scroll">
      <div class="usage-card">
        <div class="usage-plan-row">
          <span class="tier-pill">Google AI Ultra</span>
          <span style="font-size:14.5px;color:${THEME.textSecondary};">alex@acme.dev</span>
        </div>
        <div class="credit-row">
          <span style="color:${THEME.textSecondary};font-weight:500;">AI Credits</span>
          <span style="color:${THEME.textPrimary};font-weight:700;">4,820 / 5,000</span>
        </div>
      </div>

      <div class="usage-section-title">QUOTA POOLS</div>
      <div class="usage-card">
        <div style="font-size:15px;font-weight:700;color:${THEME.textSecondary};">Antigravity Pro Pool</div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">5-hour window</span>
            <span class="pct-pill" style="background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">84% left</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:84%;background:${THEME.runningSolid};"></div></div>
          <div class="quota-reset">Resets in 2h 18m</div>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Weekly allowance</span>
            <span class="pct-pill" style="background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">68% left</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:68%;background:${THEME.runningSolid};"></div></div>
          <div class="quota-reset">Resets in 4d 6h</div>
        </div>
      </div>

      <div class="usage-section-title">MODEL QUOTAS</div>
      <div class="usage-card">
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Gemini 3.1 Pro <span class="default-tag">DEFAULT</span></span>
            <span class="pct-pill" style="background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">84%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:84%;background:${THEME.runningSolid};"></div></div>
          <div class="quota-reset">Resets in 2h 18m</div>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Claude Sonnet 4.6 <span class="default-tag">REC</span></span>
            <span class="pct-pill" style="background:${THEME.approvalSoft};border-color:${THEME.approvalBorder};color:${THEME.approvalText};">45%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:45%;background:${THEME.approval};"></div></div>
          <div class="quota-reset">Resets in 1h 42m</div>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Gemini 3 Flash</span>
            <span class="pct-pill" style="background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">100%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:100%;background:${THEME.runningSolid};"></div></div>
          <div class="quota-reset">Available</div>
        </div>
      </div>

      <div class="usage-section-title">WORKSTATION ACTIVITY</div>
      <div class="metrics-grid">
        <div class="metric-tile">
          <div class="metric-val">3</div>
          <div class="metric-lbl">Machines</div>
        </div>
        <div class="metric-tile">
          <div class="metric-val" style="color:${THEME.running};">2</div>
          <div class="metric-lbl">Running</div>
        </div>
        <div class="metric-tile">
          <div class="metric-val">148</div>
          <div class="metric-lbl">Steps (11)</div>
        </div>
      </div>
    </div>
    ${bottomModeBarHtml('usage', tablet)}
  </div>`;
}

function settingsDrawerHtml({ widthStyle }) {
  return `
  <div class="drawer-panel" style="${widthStyle}">
    <div class="drawer-header">
      <div class="machine-pill">
        <span class="machine-dot"></span>
        <span>Mac Studio</span>
        ${SVG_ICONS.chevronDown(14, THEME.textMuted)}
      </div>
      <span style="font-size:17px;font-weight:700;color:${THEME.textSecondary};">Settings</span>
    </div>
    <div class="drawer-scroll" style="gap:15px;">
      <div class="settings-section">
        <div class="settings-label">Action Notifications</div>
        <div class="settings-desc">Notify when an agent needs approval, asks a question, or finishes. Updates with open action count; opens the thread (if 1) or Inbox (if multiple).</div>
        <div class="chip-row">
          <div class="chip">Off</div>
          <div class="chip">Approvals</div>
          <div class="chip selected">All Attention</div>
        </div>
        <div class="settings-hint">Active for approvals, questions &amp; finished runs • Background updates enabled.</div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-section">
        <div class="settings-label">Stay Connected in Background</div>
        <div class="settings-desc">Avoid reconnecting while switching to 2FA, chat, or browser apps, and keep updating state for alerts while the phone is locked.</div>
        <div class="chip-row">
          <div class="chip">Off</div>
          <div class="chip">5m</div>
          <div class="chip">15m</div>
          <div class="chip selected">30m</div>
          <div class="chip">60m</div>
        </div>
        <div class="settings-hint">Active for up to 30m while backgrounded or locked.</div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-section">
        <div class="settings-label">Workspace &amp; Troubleshooting</div>
        <div class="action-list">
          <div class="action-row">${SVG_ICONS.refresh(17, THEME.textSecondary)}<span>Reload Current Page</span></div>
          <div class="action-row">${SVG_ICONS.grid(17, THEME.textSecondary)}<span>All Machines Overview</span></div>
          <div class="action-row" style="border-color:${THEME.primaryBorder};background:${THEME.surfaceRaised};justify-content:space-between;">
            <span style="display:flex;align-items:center;gap:12px;">${SVG_ICONS.link(17, THEME.primaryText)}<span>Open Link or Machine ID</span></span>
            ${SVG_ICONS.chevronDown(14, THEME.primaryText)}
          </div>
          <div class="handoff-box">
            <span style="font-size:13.5px;color:${THEME.textMuted};">Paste a /remote-control link or machine ID:</span>
            <div class="handoff-input-row">
              <div class="handoff-input">antigravity.google.com/r/mac-studio</div>
              <div class="go-btn">Go</div>
            </div>
          </div>
        </div>
      </div>

      <div style="margin-top:auto;display:flex;flex-direction:column;gap:12px;padding-top:6px;">
        <div style="display:flex;align-items:center;gap:9px;font-size:14.5px;color:${THEME.textSecondary};">
          <span class="machine-dot"></span>
          <span>Signed in • Session stored locally on device</span>
        </div>
        <div class="signout-btn">Sign Out of Google Account</div>
        <div style="text-align:center;font-size:13px;color:${THEME.textMuted};">
          Privacy Policy • Open Source (MIT)
        </div>
      </div>
    </div>
    ${bottomModeBarHtml('settings', false)}
  </div>`;
}

function workspaceChatHtml({ showEdgeHandle = false, tablet = false }) {
  return `
  <div class="workspace-pane">
    ${
      showEdgeHandle
        ? `<div class="left-edge-handle">
            <div class="handle-line"></div>
            <div class="handle-pill">3</div>
          </div>`
        : ''
    }
    <div class="ws-header">
      ${tablet ? '' : `<div>${SVG_ICONS.back()}</div>`}
      <div class="ws-header-meta">
        <div class="ws-project-pill">
          ${SVG_ICONS.folder(13, THEME.textMuted)}
          <span>backend-api</span>
        </div>
        <div class="ws-thread-title">Deploy production schema migration</div>
      </div>
    </div>
    <div class="ws-body">
      ${
        tablet
          ? ''
          : `<div class="user-bubble" style="max-width:78%;">
              Can we add a composite index on <code style="font-family:${MONO_STACK};color:${THEME.primaryText};">session_events(org_id, updated_at DESC)</code> without blocking writes?
            </div>
            <div class="agent-block" style="gap:9px;">
              <div class="thought-pill">
                ${SVG_ICONS.checkCircle(14, THEME.running)}
                <span>Inspected schema.prisma &amp; query plans • p99 drops 410ms → 14ms</span>
              </div>
              <div class="agent-text">
                Yes — Postgres supports <code style="font-family:${MONO_STACK};color:#BFDBFE;">CREATE INDEX CONCURRENTLY</code> outside a transaction block. I drafted migration <code style="font-family:${MONO_STACK};color:#BFDBFE;">20261121_session_idx</code> and verified query plans on staging.
              </div>
            </div>`
      }
      <div class="user-bubble">
        Verify the new composite index on <code style="font-family:${MONO_STACK};color:${THEME.primaryText};">session_events</code> and apply the migration once all checks pass.
      </div>
      <div class="agent-block">
        <div class="thought-pill">
          <span style="width:8px;height:8px;border-radius:50%;background:${THEME.running};"></span>
          <span>Thought for 6s • 4 files inspected • 42 tests passed</span>
        </div>
        <div class="agent-text">
          Verified zero table locks using <code style="font-family:${MONO_STACK};color:#BFDBFE;">CREATE INDEX CONCURRENTLY</code> and validated rollback scripts against staging. Ready to apply migration <code style="font-family:${MONO_STACK};color:#BFDBFE;">20261121_session_idx</code>.
        </div>
        <div class="diff-card">
          <div class="diff-header">
            <span>prisma/migrations/20261121_session_idx/migration.sql</span>
            <span style="color:${THEME.running};">+4 -0</span>
          </div>
          <div class="diff-line diff-ctx">  -- Non-blocking composite index for inbox queries</div>
          <div class="diff-line diff-add">+ CREATE INDEX CONCURRENTLY IF NOT EXISTS</div>
          <div class="diff-line diff-add">+   "idx_session_events_org_updated"</div>
          <div class="diff-line diff-add">+   ON "session_events" ("org_id", "updated_at" DESC);</div>
        </div>
        <div class="diff-card" style="border-color:rgba(52,211,153,0.24);">
          <div class="diff-header" style="background:rgba(16,185,129,0.08);">
            <span style="display:flex;align-items:center;gap:7px;color:${THEME.runningText};">
              ${SVG_ICONS.checkCircle(14, THEME.running)}
              <span>Staging Dry-Run Verification</span>
            </span>
            <span style="color:${THEME.runningText};font-size:12.5px;">PASSED • 1.4s</span>
          </div>
          <div class="diff-line diff-ctx">  ✓ pg_locks check: 0 ACCESS EXCLUSIVE locks acquired</div>
          <div class="diff-line diff-ctx">  ✓ EXPLAIN ANALYZE: Index Scan (14.2ms vs 412.8ms)</div>
        </div>
        <div class="approval-box">
          <div class="approval-hdr">
            <span style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:800;letter-spacing:0.04em;color:${THEME.approvalText};">
              ${SVG_ICONS.terminal(THEME.approvalText)}
              COMMAND APPROVAL REQUIRED
            </span>
            <span style="font-size:13px;color:${THEME.textMuted};">Mac Studio</span>
          </div>
          <div class="approval-cmd">$ npx prisma migrate deploy --schema=./prisma/schema.prisma</div>
          <div class="approval-btns">
            <div class="btn-reject">Reject</div>
            <div class="btn-allow">Allow Command</div>
          </div>
        </div>
      </div>
    </div>
    <div class="composer-bar ${tablet ? 'tablet-composer' : ''}">
      <div class="composer-box">
        <span>Ask Antigravity to inspect, edit, or run commands…</span>
        <div class="send-btn">${SVG_ICONS.send()}</div>
      </div>
    </div>
  </div>`;
}

function phoneShell(title, subtitle, screenBodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${COMMON_CSS}</style></head><body>
  <div class="studio-canvas">
    <div class="studio-grid"></div>
    <div class="phone-header">
      <div class="phone-title">${title}</div>
      <div class="phone-subtitle">${subtitle}</div>
    </div>
    <div class="phone-frame">
      <div class="phone-screen">
        ${statusBarHtml()}
        ${screenBodyHtml}
        <div class="gesture-bar"></div>
      </div>
    </div>
  </div>
  </body></html>`;
}

function phoneDrawerOverlayScreen(drawerHtml) {
  return `
  <div style="flex:1;position:relative;display:flex;overflow:hidden;">
    <div style="position:absolute;inset:0;display:flex;opacity:0.32;filter:blur(1.2px);pointer-events:none;">
      ${workspaceChatHtml({ showEdgeHandle: false, tablet: false })}
    </div>
    <div style="position:absolute;inset:0;background:rgba(0,0,0,0.48);"></div>
    ${drawerHtml}
  </div>`;
}

function lockScreenNotificationHtml() {
  const notifCard = ({
    accent,
    badgeBg,
    badgeBorder,
    badgeColor,
    badge,
    host,
    project,
    title,
    reason,
  }) => `
  <div style="display:flex;background:#1A1B22;border:1px solid rgba(255,255,255,0.09);border-radius:14px;padding:13px 15px 13px 11px;gap:12px;">
    <div style="width:6px;border-radius:4px;background:${accent};flex-shrink:0;"></div>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <span style="padding:3px 9px;border-radius:6px;background:${badgeBg};border:1px solid ${badgeBorder};color:${badgeColor};font-size:12.5px;font-weight:800;letter-spacing:0.04em;">${badge}</span>
        <span style="font-size:13.5px;color:#9DA0AE;font-weight:500;">${host}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-size:14.5px;font-weight:700;color:#C8C9D4;margin-top:2px;">
        ${SVG_ICONS.folder(14, '#BCBDC6')}
        <span>${project}</span>
      </div>
      <div style="font-size:17.5px;font-weight:700;color:#F4F5F7;line-height:1.25;">${title}</div>
      <div style="font-size:14.5px;color:#BCBDC6;">${reason}</div>
    </div>
  </div>`;

  return `
  <div style="flex:1;display:flex;flex-direction:column;padding:34px 28px 76px;background:radial-gradient(ellipse 90% 55% at 50% 8%, rgba(47, 113, 227, 0.28), rgba(11, 11, 14, 0.96) 65%), #090A0E;">
    <div style="display:flex;flex-direction:column;align-items:center;margin-top:26px;margin-bottom:46px;">
      <div style="margin-bottom:14px;opacity:0.85;">${SVG_ICONS.lock()}</div>
      <div style="font-size:108px;font-weight:200;letter-spacing:-0.04em;line-height:1;color:#FFFFFF;">10:24</div>
      <div style="margin-top:12px;font-size:24px;font-weight:500;color:#BCBDC6;">Saturday, Nov 21</div>
    </div>

    <!-- Primary Android DecoratedCustomViewStyle Action Notification -->
    <div style="background:rgba(21, 22, 29, 0.96);border:1px solid rgba(255,255,255,0.12);border-radius:26px;padding:18px 18px 20px;box-shadow:0 18px 44px rgba(0,0,0,0.62);display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:26px;height:26px;border-radius:50%;background:${THEME.primary};display:flex;align-items:center;justify-content:center;">
            ${SVG_ICONS.agyMono(15, '#FFFFFF')}
          </div>
          <span style="font-size:15.5px;font-weight:700;color:#F4F5F7;">Antigravity Remote</span>
          <span style="font-size:14.5px;color:#87888F;">• 3 actions open • now</span>
        </div>
        <div style="width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;">
          ${SVG_ICONS.chevronDown(12, '#BCBDC6')}
        </div>
      </div>

      ${notifCard({
        accent: THEME.approval,
        badgeBg: THEME.approvalSoft,
        badgeBorder: THEME.approvalBorder,
        badgeColor: THEME.approvalText,
        badge: 'NEEDS APPROVAL',
        host: 'Mac Studio',
        project: 'backend-api',
        title: 'Deploy production schema migration',
        reason: 'Approve command: npx prisma migrate deploy',
      })}
      ${notifCard({
        accent: THEME.unread,
        badgeBg: THEME.unreadSoft,
        badgeBorder: THEME.unreadBorder,
        badgeColor: THEME.unreadText,
        badge: 'FINISHED',
        host: 'Linux Devbox',
        project: 'antigravity-remote',
        title: 'Add docked sidebar for tablets & foldables',
        reason: 'Agent finished — unread updates',
      })}

      <div style="text-align:center;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);color:${THEME.primaryText};font-size:14px;font-weight:700;">
        +1 more in Thread Inbox
      </div>
    </div>

    <!-- Ongoing Keep-Alive Status Notification -->
    <div style="margin-top:16px;background:rgba(21, 22, 29, 0.90);border:1px solid rgba(255,255,255,0.09);border-radius:22px;padding:16px 18px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:9px;">
          <div style="width:22px;height:22px;border-radius:50%;background:#1E2430;border:1px solid rgba(138,180,248,0.3);display:flex;align-items:center;justify-content:center;">
            ${SVG_ICONS.agyMono(12, '#8AB4F8')}
          </div>
          <span style="font-size:14.5px;font-weight:700;color:#E2E4EC;">Antigravity Remote</span>
          <span style="font-size:13.5px;color:#87888F;">• Keep-Alive Active</span>
        </div>
        <span style="font-size:13.5px;font-weight:600;color:${THEME.running};">28m left</span>
      </div>
      <div style="font-size:14.5px;color:#BCBDC6;padding-left:31px;">
        Keeping remote workstation sessions connected &amp; checking for alerts.
      </div>
      <div style="padding-left:31px;margin-top:4px;">
        <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);font-size:13.5px;font-weight:700;color:#8AB4F8;">Stop Keep-Alive</span>
      </div>
    </div>

    <div style="margin-top:auto;text-align:center;font-size:15.5px;font-weight:600;color:#87888F;">
      Tap any card to open that thread directly • 100% on-device evaluation
    </div>
  </div>`;
}

function tabletShell(title, subtitle, drawerHtml, compactTablet = false) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${COMMON_CSS}</style></head><body>
  <div class="studio-canvas">
    <div class="studio-grid"></div>
    <div class="tablet-header" style="${compactTablet ? 'padding: 26px 56px 18px;' : ''}">
      <div class="tablet-title" style="${compactTablet ? 'font-size: 35px;' : ''}">${title}</div>
      <div class="tablet-subtitle" style="${compactTablet ? 'font-size: 19.5px;' : ''}">${subtitle}</div>
    </div>
    <div class="tablet-frame" style="${compactTablet ? 'width: calc(100% - 88px); margin-bottom: 26px;' : ''}">
      <div class="tablet-screen">
        ${statusBarHtml('10:24', true)}
        <div class="tablet-split">
          ${drawerHtml}
          ${workspaceChatHtml({ showEdgeHandle: false, tablet: true })}
        </div>
      </div>
    </div>
  </div>
  </body></html>`;
}

function featureGraphicHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${COMMON_CSS}
  .fg-root {
    width: 1024px;
    height: 500px;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 44px 54px;
    gap: 38px;
    background:
      radial-gradient(ellipse 68% 78% at 18% 20%, rgba(47, 113, 227, 0.25), transparent 68%),
      radial-gradient(ellipse 52% 66% at 88% 82%, rgba(245, 158, 11, 0.14), transparent 70%),
      linear-gradient(135deg, #090B10 0%, #0E1016 55%, #0A0B0F 100%);
  }
  .fg-left {
    position: relative;
    z-index: 2;
    flex: 1.15;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .fg-brand-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .fg-icon {
    width: 78px;
    height: 78px;
    border-radius: 20px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255,255,255,0.14);
    flex-shrink: 0;
  }
  .fg-title {
    font-size: 46px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.08;
    color: #FFFFFF;
  }
  .fg-sub {
    font-size: 20px;
    font-weight: 500;
    line-height: 1.38;
    color: #BCBDC6;
    max-width: 500px;
  }
  .fg-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin-top: 4px;
  }
  .fg-pill {
    padding: 7px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 13.5px;
    font-weight: 700;
    color: #E2E4EC;
  }
  .fg-right {
    position: relative;
    z-index: 2;
    width: 382px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border-radius: 22px;
    background: rgba(17, 17, 20, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.68);
  }
  .fg-mini-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px 4px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    font-size: 13px;
    font-weight: 700;
    color: #BCBDC6;
  }
  .fg-card {
    background: #17171D;
    border: 1px solid rgba(255,255,255,0.09);
    border-left-width: 4px;
    border-radius: 12px;
    padding: 11px 13px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  </style></head><body>
  <div class="fg-root">
    <div class="studio-grid"></div>
    <div class="fg-left">
      <div class="fg-brand-row">
        <img class="fg-icon" src="${ICON_DATA_URI}" alt="Antigravity Remote" />
        <div class="fg-title">Antigravity<br/>Remote</div>
      </div>
      <div class="fg-sub">
        Cross-workstation Thread Inbox, Projects, live quotas, and proactive lock-screen alerts on Android &amp; tablets.
      </div>
      <div class="fg-pills">
        <span class="fg-pill" style="background:${THEME.primarySoft};border-color:${THEME.primaryBorder};color:${THEME.primaryText};">Thread Inbox</span>
        <span class="fg-pill">Projects</span>
        <span class="fg-pill">Live Alerts</span>
        <span class="fg-pill">Tablet Sidebar</span>
        <span class="fg-pill">Open Source</span>
      </div>
    </div>
    <div class="fg-right">
      <div class="fg-mini-hdr">
        <span style="display:flex;align-items:center;gap:7px;"><span class="machine-dot" style="width:8px;height:8px;"></span>Mac Studio • 3 online</span>
        <span style="padding:2px 8px;border-radius:999px;background:${THEME.approval};color:#111114;font-size:11px;font-weight:800;">2 OPEN</span>
      </div>
      <div class="fg-card" style="border-left-color:${THEME.approval};">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="kind-badge" style="font-size:10px;padding:2px 7px;background:${THEME.approvalSoft};border-color:${THEME.approvalBorder};color:${THEME.approvalText};">NEEDS APPROVAL</span>
          <span style="font-size:11px;color:${THEME.textMuted};">Just now</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:${THEME.textSecondary};margin-top:2px;">
          ${SVG_ICONS.folder(11, THEME.textSecondary)}<span>backend-api</span>
        </div>
        <div style="font-size:14px;font-weight:700;color:#F4F5F7;">Deploy production schema migration</div>
        <div style="font-size:11.5px;color:${THEME.approvalText};">Approve command: npx prisma migrate deploy</div>
      </div>
      <div class="fg-card" style="border-left-color:${THEME.unread};">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="kind-badge" style="font-size:10px;padding:2px 7px;background:${THEME.unreadSoft};border-color:${THEME.unreadBorder};color:${THEME.unreadText};">FINISHED</span>
          <span style="font-size:11px;color:${THEME.textMuted};">2m ago</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:${THEME.textSecondary};margin-top:2px;">
          ${SVG_ICONS.folder(11, THEME.textSecondary)}<span>antigravity-remote</span>
        </div>
        <div style="font-size:14px;font-weight:700;color:#F4F5F7;">Docked tablet sidebar &amp; lock alerts</div>
        <div style="font-size:11.5px;color:${THEME.unreadText};">Agent finished — unread updates</div>
      </div>
      <div class="fg-card" style="border-left-color:${THEME.runningSolid};padding:9px 13px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="kind-badge" style="font-size:10px;padding:2px 7px;background:${THEME.runningSoft};border-color:${THEME.runningBorder};color:${THEME.runningText};">WORKING</span>
          <span style="font-size:11px;color:${THEME.runningText};">84% quota left</span>
        </div>
      </div>
    </div>
  </div>
  </body></html>`;
}

function playIconHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; }
  html, body { width: 512px; height: 512px; overflow: hidden; background: #121417; }
  img { width: 512px; height: 512px; display: block; }
  </style></head><body><img src="${ICON_DATA_URI}" alt="Antigravity Remote Icon" /></body></html>`;
}

function buildAssetSpecs() {
  const specs = [
    {
      relPath: 'icon/play-icon-512.png',
      width: 512,
      height: 512,
      html: playIconHtml(),
    },
    {
      relPath: 'feature-graphic/feature-graphic-1024x500.png',
      width: 1024,
      height: 500,
      html: featureGraphicHtml(),
    },
    {
      relPath: 'phone-screenshots/1.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Cross-Workstation Thread Inbox',
        'Track approvals, errors &amp; completions across every machine',
        phoneDrawerOverlayScreen(inboxDrawerHtml({ widthStyle: 'width: 752px;' })),
      ),
    },
    {
      relPath: 'phone-screenshots/2.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Organize Chats by Project',
        'Browse server projects, launch chats &amp; add remote folders',
        phoneDrawerOverlayScreen(
          projectsDrawerHtml({ widthStyle: 'width: 752px;' }),
        ),
      ),
    },
    {
      relPath: 'phone-screenshots/3.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Proactive Lock-Screen Alerts',
        'Color-coded cards update live while your phone is locked',
        lockScreenNotificationHtml(),
      ),
    },
    {
      relPath: 'phone-screenshots/4.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Full-Bleed Mobile Workspace',
        'Project headers, inline approvals &amp; gesture-safe drawer handle',
        workspaceChatHtml({ showEdgeHandle: true, tablet: false }),
      ),
    },
    {
      relPath: 'phone-screenshots/5.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Live Quotas &amp; Usage Tracking',
        'Monitor AI credits, quota pools &amp; model reset countdowns',
        phoneDrawerOverlayScreen(usageDrawerHtml({ widthStyle: 'width: 752px;' })),
      ),
    },
    {
      relPath: 'phone-screenshots/6.png',
      width: 1080,
      height: 1920,
      html: phoneShell(
        'Bounded Keep-Alive &amp; Handoff',
        'Configure alerts, background timer &amp; instant /remote-control links',
        phoneDrawerOverlayScreen(
          settingsDrawerHtml({ widthStyle: 'width: 752px;' }),
        ),
      ),
    },
    {
      relPath: 'tablet-screenshots/1.png',
      width: 1728,
      height: 1080,
      html: tabletShell(
        'Docked Side-by-Side Workspace',
        'Live Thread Inbox alongside your active coding session',
        inboxDrawerHtml({ widthStyle: 'width: 530px; flex-shrink: 0;', tablet: true }),
        true,
      ),
    },
    {
      relPath: 'tablet-screenshots/2.png',
      width: 1728,
      height: 1080,
      html: tabletShell(
        'Projects Across Every Workstation',
        'Group threads by project and launch new chats in one tap',
        projectsDrawerHtml({ widthStyle: 'width: 530px; flex-shrink: 0;', tablet: true }),
        true,
      ),
    },
    {
      relPath: 'tablet-screenshots/3.png',
      width: 1728,
      height: 1080,
      html: tabletShell(
        'Live Model Quotas &amp; Activity',
        'Inspect 5-hour &amp; weekly pools without leaving your thread',
        usageDrawerHtml({ widthStyle: 'width: 530px; flex-shrink: 0;', tablet: true }),
        true,
      ),
    },
    {
      relPath: 'large-tablet-screenshots/1.png',
      width: 1920,
      height: 1200,
      html: tabletShell(
        'Docked Side-by-Side Tablet Workspace',
        'Cross-workstation Thread Inbox docked beside your live Antigravity session',
        inboxDrawerHtml({ widthStyle: 'width: 575px; flex-shrink: 0;', tablet: true }),
        false,
      ),
    },
    {
      relPath: 'large-tablet-screenshots/2.png',
      width: 1920,
      height: 1200,
      html: tabletShell(
        'Server Projects &amp; Remote Folders',
        'Switch workstations, expand project threads, and start new chats instantly',
        projectsDrawerHtml({ widthStyle: 'width: 575px; flex-shrink: 0;', tablet: true }),
        false,
      ),
    },
    {
      relPath: 'large-tablet-screenshots/3.png',
      width: 1920,
      height: 1200,
      html: tabletShell(
        'Live Quotas &amp; Workstation Activity',
        'Track credits, model reset windows, and running tasks side by side',
        usageDrawerHtml({ widthStyle: 'width: 575px; flex-shrink: 0;', tablet: true }),
        false,
      ),
    },
  ];
  const manifestPath = path.join(ROOT, 'store-assets/screenshots/capture-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Native screenshots are missing. Run npm run capture:play-screenshots first.');
  }
  const captured = new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).captures.map(item => [item.playPath, item]));
  return specs.map(spec => {
    if (!/(?:^|\/)(?:phone|tablet|large-tablet)-screenshots\//.test(spec.relPath)) return spec;
    const item = captured.get(spec.relPath);
    if (!item) throw new Error(`Missing native capture for ${spec.relPath}. Retake the screenshot set.`);
    const sourcePath = path.join(ROOT, item.file);
    const png = fs.readFileSync(sourcePath);
    if (crypto.createHash('sha256').update(png).digest('hex') !== item.sha256) {
      throw new Error(`Native screenshot checksum changed: ${item.file}`);
    }
    if (item.playWidth === item.width && item.playHeight === item.height) {
      return { ...spec, width: item.width, height: item.height, copyFrom: sourcePath };
    }
    return {
      ...spec, width: item.playWidth, height: item.playHeight,
      html: `<!doctype html><html><head><style>*{box-sizing:border-box;margin:0}html,body{width:${item.playWidth}px;height:${item.playHeight}px;overflow:hidden;background:#0B0B0E}body{display:flex;justify-content:center}img{display:block;flex-shrink:0;width:${item.width}px;height:${item.height}px}</style></head><body><img src="data:image/png;base64,${png.toString('base64')}" alt="Native Android sample-data screenshot"></body></html>`,
    };
  });
}

function renderOne(chromeBin, tmpDir, spec, index) {
  return new Promise((resolve, reject) => {
    if (spec.copyFrom) {
      const outPath = spec.outPath || path.join(GRAPHICS_DIR, spec.relPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(spec.copyFrom, outPath);
      resolve({ relPath: spec.relPath, width: spec.width, height: spec.height, bytes: fs.statSync(outPath).size });
      return;
    }
    const htmlPath = path.join(tmpDir, `asset-${index}.html`);
    const outPath = path.join(GRAPHICS_DIR, spec.relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(htmlPath, spec.html, 'utf8');

    const userDataDir = path.join(tmpDir, `profile-${index}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${spec.width},${spec.height}`,
      `--screenshot=${outPath}`,
      `file://${htmlPath}`,
    ];

    const child = spawn(chromeBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        reject(
          new Error(
            `Failed to render ${spec.relPath} (exit ${code}): ${stderr.slice(0, 400)}`,
          ),
        );
        return;
      }
      const buf = fs.readFileSync(outPath);
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w !== spec.width || h !== spec.height) {
        reject(
          new Error(
            `Rendered ${spec.relPath} with unexpected dimensions ${w}x${h} (expected ${spec.width}x${spec.height})`,
          ),
        );
        return;
      }
      resolve({ relPath: spec.relPath, width: w, height: h, bytes: buf.length });
    });
  });
}

async function generatePlayAssets(options = {}) {
  const chromeBin = findChromiumBinary();
  const specs = buildAssetSpecs().filter(spec => !options.screenshotsOnly || /(?:^|\/)(?:phone|tablet|large-tablet)-screenshots\//.test(spec.relPath));

  // Remove stale extra PNGs in managed graphic directories so Play Publisher
  // never uploads obsolete screenshots from earlier releases.
  const expectedByDir = new Map();
  for (const spec of specs) {
    const dir = path.dirname(spec.relPath);
    const base = path.basename(spec.relPath);
    if (!expectedByDir.has(dir)) expectedByDir.set(dir, new Set());
    expectedByDir.get(dir).add(base);
  }
  for (const [dir, expectedFiles] of expectedByDir.entries()) {
    const fullDir = path.join(GRAPHICS_DIR, dir);
    if (!fs.existsSync(fullDir)) continue;
    for (const file of fs.readdirSync(fullDir)) {
      if (file.endsWith('.png') && !expectedFiles.has(file)) {
        fs.unlinkSync(path.join(fullDir, file));
      }
    }
  }

  // Create temp directory inside ROOT (under $HOME) rather than /tmp so
  // Snap-confined Chromium on Ubuntu can read/write HTML & profile files.
  const tmpDir = fs.mkdtempSync(path.join(ROOT, '.tmp-play-assets-'));
  try {
    const concurrency = 4;
    const results = [];
    for (let i = 0; i < specs.length; i += concurrency) {
      const batch = specs
        .slice(i, i + concurrency)
        .map((spec, offset) => renderOne(chromeBin, tmpDir, spec, i + offset));
      results.push(...(await Promise.all(batch)));
    }
    for (const r of results) {
      console.log(
        `Generated ${r.relPath} (${r.width}x${r.height}, ${(r.bytes / 1024).toFixed(1)} KB)`,
      );
    }
    return results;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { generatePlayAssets, buildAssetSpecs };

if (require.main === module) {
  generatePlayAssets({ screenshotsOnly: process.argv.includes('--screenshots-only') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
