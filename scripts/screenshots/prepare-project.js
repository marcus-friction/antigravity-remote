// Build a separate sample-data app. Production entry points and signing
// configuration are never changed, and private signing/publisher files are excluded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CAPTURE_ROOT = process.env.CAPTURE_PROJECT_DIR || path.join(os.tmpdir(), 'antigravity-pixel10-capture');

function prepareProject() {
  fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
  const excluded = new Set(['build', '.gradle', '.cxx', '.kotlin', 'keystore.properties', 'play-service-account.json', 'local.properties']);
  const filter = (source) => {
    const name = path.basename(source);
    return !excluded.has(name) && !/\.(jks|p12|p8|key)$/.test(name) && (!name.endsWith('.keystore') || name === 'debug.keystore');
  };
  for (const name of ['src', 'modules', 'android', 'assets', 'plugins', 'scripts/screenshots']) {
    const destination = path.join(CAPTURE_ROOT, name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, name), destination, { recursive: true, filter, dereference: false });
  }
  for (const name of ['app.json', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(CAPTURE_ROOT, name));
  }
  const dependencies = path.join(CAPTURE_ROOT, 'node_modules');
  if (!fs.existsSync(dependencies)) fs.symlinkSync(path.join(ROOT, 'node_modules'), dependencies, 'dir');
  fs.writeFileSync(path.join(CAPTURE_ROOT, 'index.ts'), "import { registerRootComponent } from 'expo';\nimport CaptureApp from './scripts/screenshots/CaptureApp';\nregisterRootComponent(CaptureApp);\n");
  fs.writeFileSync(path.join(CAPTURE_ROOT, 'App.tsx'), "export { default } from './scripts/screenshots/CaptureApp';\n");
  fs.writeFileSync(path.join(CAPTURE_ROOT, 'metro.config.js'), `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [${JSON.stringify(ROOT)}];
config.resolver.nodeModulesPaths = [${JSON.stringify(path.join(ROOT, 'node_modules'))}];
module.exports = config;
`);
  fs.appendFileSync(path.join(CAPTURE_ROOT, 'android/app/build.gradle'), `
// Isolated screenshot variant; this block is absent from production source.
android {
    buildTypes {
        capture {
            initWith release
            signingConfig signingConfigs.debug
            applicationIdSuffix ".screenshots"
            debuggable false
            minifyEnabled false
            shrinkResources false
            matchingFallbacks = ['release']
        }
    }
}
`);
  // Permit only the local screenshot fixture server in this temporary variant.
  const captureResources = path.join(CAPTURE_ROOT, 'android/app/src/capture/res/xml');
  fs.mkdirSync(captureResources, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_ROOT, 'android/app/src/capture/AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/network_security_config" /></manifest>\n`);
  fs.writeFileSync(path.join(captureResources, 'network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config>
</network-security-config>
`);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Android/Sdk');
  fs.writeFileSync(path.join(CAPTURE_ROOT, 'android/local.properties'), `sdk.dir=${sdk}\n`);
  return CAPTURE_ROOT;
}

if (require.main === module) console.log(prepareProject());
module.exports = { prepareProject, CAPTURE_ROOT };
