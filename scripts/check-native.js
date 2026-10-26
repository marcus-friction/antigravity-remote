const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function checkNative(root) {
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const config = JSON.parse(read('app.json')).expo;
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
  assert(
    read(
      'android/app/src/main/java/com/frictionventures/antigravityremote/MainActivity.kt',
    ).includes('// Antigravity IME insets'),
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
  return true;
}

module.exports = { checkNative };
if (require.main === module) {
  checkNative(path.resolve(__dirname, '..'));
  console.log('Native security configuration verified');
}
