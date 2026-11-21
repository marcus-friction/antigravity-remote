const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function checkNative(root, options = {}) {
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const config = JSON.parse(read('app.json')).expo;
  const pkg = JSON.parse(read('package.json'));
  const pkgLock = JSON.parse(read('package-lock.json'));
  const buildGradle = read('android/app/build.gradle');
  assert.strictEqual(
    pkg.version,
    config.version,
    `package.json version (${pkg.version}) must match app.json expo.version (${config.version})`,
  );
  assert.strictEqual(
    pkgLock.version,
    config.version,
    `package-lock.json version (${pkgLock.version}) must match app.json expo.version (${config.version})`,
  );
  if (pkgLock.packages && pkgLock.packages['']) {
    assert.strictEqual(
      pkgLock.packages[''].version,
      config.version,
      `package-lock.json packages[""].version (${pkgLock.packages[''].version}) must match app.json expo.version (${config.version})`,
    );
  }
  const gradleVersionNameMatch = /versionName\s+"([^"]+)"/.exec(buildGradle);
  const gradleVersionCodeMatch = /versionCode\s+(\d+)/.exec(buildGradle);
  assert(
    gradleVersionNameMatch && gradleVersionNameMatch[1] === config.version,
    `android/app/build.gradle versionName (${gradleVersionNameMatch?.[1]}) must match app.json expo.version (${config.version})`,
  );
  assert(
    gradleVersionCodeMatch &&
      Number(gradleVersionCodeMatch[1]) === Number(config.android.versionCode),
    `android/app/build.gradle versionCode (${gradleVersionCodeMatch?.[1]}) must match app.json expo.android.versionCode (${config.android.versionCode})`,
  );
  if (options.checkPlayMetadata !== false) {
    const releaseNotesPath = path.join(
      root,
      'android/app/src/main/play/release-notes/en-US/default.txt',
    );
    assert(
      fs.existsSync(releaseNotesPath),
      'Missing Play Store release notes file: android/app/src/main/play/release-notes/en-US/default.txt',
    );
    const releaseNotes = fs.readFileSync(releaseNotesPath, 'utf8').trim();
    assert(
      releaseNotes.length > 0,
      'Play Store release notes (en-US/default.txt) must not be empty',
    );
    assert(
      releaseNotes.length <= 500,
      `Play Store release notes exceed 500-character Google Play limit (${releaseNotes.length} chars)`,
    );
  }
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  for (const attribute of [
    'allowBackup="false"',
    'fullBackupContent="false"',
    'usesCleartextTraffic="false"',
    'dataExtractionRules="@xml/remote_data_extraction_rules"',
  ]) {
    assert(
      manifest.includes(attribute),
      `Missing Android security setting: ${attribute}`,
    );
  }
  assert(
    !manifest.includes('android:host="antigravity.google.com"'),
    'Unverified HTTPS link registration',
  );
  assert(
    !config.ios.associatedDomains?.length,
    'Unverified iOS link registration',
  );
  const properties = read('android/gradle.properties');
  for (const setting of [
    'android.enableMinifyInReleaseBuilds=true',
    'android.enableShrinkResourcesInReleaseBuilds=true',
    'android.compileSdkVersion=36',
    'android.targetSdkVersion=36',
  ])
    assert(properties.includes(setting), setting);
  assert(
    read('android/app/build.gradle').includes(
      'apply from: new File(rootDir, "../plugins/android-release.gradle")',
    ),
  );
  const signing = read('plugins/android-release.gradle');
  assert(
    signing.includes('signingConfig signingConfigs.release') &&
      signing.includes('throw new GradleException'),
  );
  const mainActivity = read(
    'android/app/src/main/java/com/frictionventures/antigravityremote/MainActivity.kt',
  );
  assert(
    mainActivity.includes('// Antigravity IME insets') &&
      mainActivity.includes('// End Antigravity IME insets') &&
      mainActivity.includes('view.setPadding(0, 0, 0, imeBottom)') &&
      mainActivity.includes('androidx.core.graphics.Insets.NONE') &&
      mainActivity.includes(
        '.setVisible(androidx.core.view.WindowInsetsCompat.Type.ime(), false)',
      ) &&
      mainActivity.includes('androidx.core.view.WindowInsetsCompat.CONSUMED') &&
      !mainActivity.includes('ime.bottom - bars.bottom'),
    'Missing or outdated Android IME inset consumption in MainActivity.kt',
  );
  const rules = read(
    'android/app/src/main/res/xml/remote_data_extraction_rules.xml',
  );
  assert(
    rules.includes('<cloud-backup>') && rules.includes('<device-transfer>'),
  );
  assert(
    read('modules/remote-session/expo-module.config.json').includes(
      'RemoteSessionModule',
    ),
  );
  const sessionManifest = read(
    'modules/remote-session/android/src/main/AndroidManifest.xml',
  );
  for (const snippet of [
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'expo.modules.remotesession.RemoteKeepAliveService',
    'android:exported="false"',
    'android:foregroundServiceType="specialUse"',
    'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
  ]) {
    assert(
      sessionManifest.includes(snippet),
      `Missing keep-alive manifest setting: ${snippet}`,
    );
  }
  const keepAliveIcon = read(
    'modules/remote-session/android/src/main/res/drawable/ic_stat_keep_alive.xml',
  );
  assert(
    keepAliveIcon.includes('<vector') &&
      keepAliveIcon.includes('#FFFFFFFF'),
    'Missing monochrome keep-alive notification icon',
  );
  return true;
}

module.exports = { checkNative };
if (require.main === module) {
  checkNative(path.resolve(__dirname, '..'));
  console.log('Native security configuration verified');
}
