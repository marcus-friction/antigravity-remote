#!/usr/bin/env node
// Requires an Android 16 emulator with a Pixel 10 Pro display profile:
// 1280x2856, 495 dpi. All PNGs come directly from `adb exec-out screencap`.
// --build prepares/builds an isolated sample-data APK; no production app is changed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareProject, CAPTURE_ROOT } = require('./prepare-project');
const { startRendererServer } = require('./renderer-server');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'store-assets/screenshots');
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Android/Sdk');
const ADB = process.env.ADB_BIN || path.join(SDK, 'platform-tools/adb');
const APP_ID = 'com.frictionventures.antigravityremote.screenshots';
const ACTIVITY = `${APP_ID}/com.frictionventures.antigravityremote.MainActivity`;
const APK = process.env.CAPTURE_APK || path.join(CAPTURE_ROOT, 'android/app/build/outputs/apk/capture/app-capture.apk');
const captures = [];
let serial;
let rendererServer;
let needsRendererReady = true;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function adb(...args) {
  // adb joins shell arguments before sending them to Android's shell. Quote
  // them there too, including notification keys containing pipe characters.
  if (args[0] === 'shell') {
    args = ['shell', args.slice(1).map(value => `'${value.replace(/'/g, `'\\''`)}'`).join(' ')];
  }
  return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function resetAppForDisplay() {
  // React Native caches font measurements; restart after changing density.
  adb('shell', 'am', 'force-stop', APP_ID);
  needsRendererReady = true;
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit');
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'enter');
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'clock', '-e', 'hhmm', '1024');
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'network', '-e', 'mobile', 'hide', '-e', 'sims', '0', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true', '-e', 'nosim', 'hide');
}

async function showNotifications() {
  // The real keep-alive service starts when the app enters the background.
  adb('shell', 'input', 'keyevent', '3');
  await sleep(1000);
  // Hide first-boot emulator keyboard/serial-console warnings through Android,
  // before capturing the actual notification shade.
  for (const key of adb('shell', 'cmd', 'notification', 'list').trim().split('\n')) {
    if (/^-?\d+\|android\|(55|19)\|/.test(key)) {
      adb('shell', 'cmd', 'notification', 'snooze', '--for', '3600000', key);
    }
  }
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(1400);
  adb('shell', 'uiautomator', 'dump', '/sdcard/capture-notifications.xml');
  const xml = adb('shell', 'cat', '/sdcard/capture-notifications.xml');
  const button = (xml.match(/<node\b[^>]*>/g) || []).find(node => node.includes('resource-id="android:id/expand_button"'));
  if (!button) throw new Error('The native notification card is missing.');
  if (button.includes('content-desc="Expand"')) {
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(button);
    if (!bounds) throw new Error('Cannot locate the notification expand button.');
    adb('shell', 'input', 'tap', String(Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2)), String(Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2)));
    await sleep(600);
  }
}

async function openScreen(screen) {
  const expectedReady = rendererServer.readyCount + 1;
  adb('shell', 'cmd', 'statusbar', 'collapse');
  adb('shell', 'am', 'start', '-W', '-n', ACTIVITY, '-a', 'android.intent.action.VIEW', '-d', `antigravity-remote://capture?screen=${screen}`);
  await sleep(1700);
  if (needsRendererReady) {
    const deadline = Date.now() + 30_000;
    while (rendererServer.readyCount < expectedReady) {
      if (Date.now() > deadline) throw new Error('The upstream sample conversation did not finish rendering. No screenshot was taken.');
      await sleep(250);
    }
    needsRendererReady = false;
  }
}

function capture(file, playPath, width, height, profile) {
  const png = execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`Unexpected screenshot size for ${file}: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  const destination = path.join(OUTPUT, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, png);
  const published = path.join(ROOT, 'android/app/src/main/play/listings/en-US/graphics', playPath);
  fs.mkdirSync(path.dirname(published), { recursive: true });
  if (Math.max(width, height) / Math.min(width, height) <= 2) fs.writeFileSync(published, png);
  const sha256 = crypto.createHash('sha256').update(png).digest('hex');
  captures.push({ file: path.relative(ROOT, destination), playPath, width, height,
    playWidth: Math.max(width, Math.ceil(height / 2)), playHeight: height, profile, sha256 });
  console.log(`Captured ${file}: ${width}x${height}`);
}

async function main() {
  const connected = execFileSync(ADB, ['devices'], { encoding: 'utf8' }).split('\n').filter(line => /\tdevice$/.test(line)).map(line => line.split('\t')[0]);
  serial = process.env.ANDROID_SERIAL || (connected.length === 1 ? connected[0] : null);
  if (!serial) throw new Error('Connect one capture emulator or set ANDROID_SERIAL.');
  if (Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim()) < 36) throw new Error('Android 16 / API 36 is required for the native notification captures.');
  if (process.argv.includes('--build')) {
    const project = prepareProject();
    execFileSync(path.join(project, 'android/gradlew'), [
      'assembleCapture', '-PreactNativeArchitectures=x86_64', '--no-parallel', '--max-workers=2',
      '-Pkotlin.compiler.execution.strategy=in-process', '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m',
    ], { cwd: path.join(project, 'android'), stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', CI: '1' } });
  }
  if (!fs.existsSync(APK)) throw new Error('Build the sample-data APK first with --build or set CAPTURE_APK.');
  rendererServer = await startRendererServer();
  adb('reverse', `tcp:${rendererServer.port}`, `tcp:${rendererServer.port}`);
  adb('install', '-r', APK);
  adb('shell', 'pm', 'grant', APP_ID, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'wm', 'size', 'reset');
  adb('shell', 'wm', 'density', 'reset');
  if (!adb('shell', 'wm', 'size').includes('1280x2856')) throw new Error('The capture emulator must have a native 1280x2856 Pixel 10 Pro display profile.');
  adb('shell', 'cmd', 'uimode', 'night', 'yes');
  adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000');
  adb('shell', 'input', 'keyevent', '82');
  resetAppForDisplay();
  await sleep(1000);
  const phoneScreens = ['thread', 'inbox', 'notifications', 'projects', 'usage', 'settings'];
  for (const [index, screen] of phoneScreens.entries()) {
    await openScreen(screen);
    if (screen === 'notifications') {
      await showNotifications();
    }
    const file = `pixel-10-pro/${index + 1}-${screen}.png`;
    capture(file, `phone-screenshots/${index + 1}.png`, 1280, 2856, 'Pixel 10 Pro display profile / Android 16');
    fs.copyFileSync(path.join(OUTPUT, file), path.join(OUTPUT, `phone-${index + 1}.png`));
  }
  try {
    adb('shell', 'cmd', 'statusbar', 'collapse');
    adb('shell', 'cmd', 'overlay', 'disable', 'com.android.internal.display.cutout.emulation.hole');
    for (const tablet of [
      { folder: 'tablet-screenshots', name: 'tablet-7', width: 1728, height: 1080, density: 220 },
      { folder: 'large-tablet-screenshots', name: 'tablet-10', width: 1920, height: 1200, density: 240 },
    ]) {
      adb('shell', 'wm', 'size', `${tablet.width}x${tablet.height}`);
      adb('shell', 'wm', 'density', String(tablet.density));
      await sleep(2000);
      resetAppForDisplay();
      for (const [index, screen] of ['inbox', 'projects', 'usage'].entries()) {
        await openScreen(screen);
        const file = `${tablet.name}/${index + 1}-${screen}.png`;
        capture(file, `${tablet.folder}/${index + 1}.png`, tablet.width, tablet.height, `Android tablet viewport / ${tablet.density} dpi`);
        if (tablet.name === 'tablet-7' && index < 2) fs.copyFileSync(path.join(OUTPUT, file), path.join(OUTPUT, `tablet-${index + 1}.png`));
      }
    }
  } finally {
    adb('shell', 'wm', 'size', 'reset');
    adb('shell', 'wm', 'density', 'reset');
    adb('shell', 'cmd', 'overlay', 'enable', 'com.android.internal.display.cutout.emulation.hole');
    resetAppForDisplay();
    await openScreen('thread');
  }
  const manifest = {
    capturedAt: new Date().toISOString(), method: 'Android emulator / adb exec-out screencap -p',
    data: 'Local sample RPC responses rendered by the unmodified upstream Antigravity Remote Control web UI. Drawer and notifications use production components.',
    upstreamRenderer: rendererServer.provenance(),
    phone: { profile: 'Pixel 10 Pro display configuration', width: 1280, height: 2856, densityDpi: 495, androidVersion: adb('shell', 'getprop', 'ro.build.version.release').trim() },
    apkSha256: crypto.createHash('sha256').update(fs.readFileSync(APK)).digest('hex'),
    sources: Object.fromEntries(['src/components/LeftNavigationDrawer.tsx', 'src/constants/theme.ts', 'modules/remote-session/android/src/main/java/expo/modules/remotesession/RemoteSessionModule.kt', 'scripts/screenshots/CaptureApp.tsx', 'scripts/screenshots/sampleData.ts', 'scripts/screenshots/threadData.json', 'scripts/screenshots/upstream-renderer.json', 'scripts/screenshots/renderer-host.html', 'scripts/screenshots/renderer-server.js', 'scripts/screenshots/protobuf-fixtures.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')])),
    captures,
  };
  fs.writeFileSync(path.join(OUTPUT, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Saved ${captures.length} unedited native captures and provenance manifest.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (rendererServer) {
    adb('reverse', '--remove', `tcp:${rendererServer.port}`);
    await rendererServer.close();
  }
});
