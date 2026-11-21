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
    const playListingDir = path.join(
      root,
      'android/app/src/main/play/listings/en-US',
    );
    const readPlayText = (relPath, label, maxChars) => {
      const fullPath = path.join(root, relPath);
      assert(fs.existsSync(fullPath), `Missing Play Store file: ${relPath}`);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      assert(content.length > 0, `Play Store ${label} must not be empty`);
      assert(
        content.length <= maxChars,
        `Play Store ${label} exceeds ${maxChars}-character limit (${content.length} chars)`,
      );
    };
    const readPngDimensions = (fullPath) => {
      assert(fs.existsSync(fullPath), `Missing Play Store graphic: ${fullPath}`);
      const buf = fs.readFileSync(fullPath);
      assert(
        buf.length >= 24 &&
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47,
        `Invalid PNG header: ${fullPath}`,
      );
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    };

    readPlayText(
      'android/app/src/main/play/release-notes/en-US/default.txt',
      'release notes (en-US/default.txt)',
      500,
    );
    readPlayText(
      'android/app/src/main/play/listings/en-US/title.txt',
      'title',
      30,
    );
    readPlayText(
      'android/app/src/main/play/listings/en-US/short-description.txt',
      'short description',
      80,
    );
    readPlayText(
      'android/app/src/main/play/listings/en-US/full-description.txt',
      'full description',
      4000,
    );

    const graphicsDir = path.join(playListingDir, 'graphics');
    const iconDim = readPngDimensions(
      path.join(graphicsDir, 'icon/play-icon-512.png'),
    );
    assert(
      iconDim.width === 512 && iconDim.height === 512,
      `Play Store icon must be 512x512 (found ${iconDim.width}x${iconDim.height})`,
    );
    const featureDim = readPngDimensions(
      path.join(graphicsDir, 'feature-graphic/feature-graphic-1024x500.png'),
    );
    assert(
      featureDim.width === 1024 && featureDim.height === 500,
      `Play Store feature graphic must be 1024x500 (found ${featureDim.width}x${featureDim.height})`,
    );

    assert(
      !fs.existsSync(path.join(graphicsDir, 'seven-inch-tablet-screenshots')),
      'Use tablet-screenshots/ (not seven-inch-tablet-screenshots/) for Gradle Play Publisher 7-inch tablet uploads',
    );
    for (const [folder, minCount, expectedMinSide] of [
      ['phone-screenshots', 2, 1080],
      ['tablet-screenshots', 2, 1080],
      ['large-tablet-screenshots', 2, 1080],
    ]) {
      const dirPath = path.join(graphicsDir, folder);
      assert(
        fs.existsSync(dirPath),
        `Missing Play Store screenshots directory: ${folder}`,
      );
      const pngs = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.png'))
        .sort();
      assert(
        pngs.length >= minCount && pngs.length <= 8,
        `${folder} must contain between ${minCount} and 8 PNG screenshots (found ${pngs.length})`,
      );
      for (const png of pngs) {
        const { width, height } = readPngDimensions(path.join(dirPath, png));
        const minSide = Math.min(width, height);
        const maxSide = Math.max(width, height);
        assert(
          minSide >= expectedMinSide && maxSide <= 3840 && maxSide / minSide <= 2,
          `${folder}/${png} (${width}x${height}) does not meet Play Store high-res screenshot bounds (minSide>=${expectedMinSide}, aspect<=2:1)`,
        );
      }
    }
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
