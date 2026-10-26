const fs = require('node:fs/promises');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withMainActivity,
  withProjectBuildGradle,
} = require('expo/config-plugins');

const KEYBOARD_TAG = '// Antigravity IME insets';

module.exports = function withRemoteSecurity(config) {
  config = withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(
      mod.modResults,
    );
    Object.assign(app.$, {
      'android:allowBackup': 'false',
      'android:fullBackupContent': 'false',
      'android:dataExtractionRules': '@xml/remote_data_extraction_rules',
      'android:usesCleartextTraffic': 'false',
    });
    // HTTPS links remain browser links until the domain owner publishes associations.
    for (const activity of app.activity ?? []) {
      activity['intent-filter'] = (activity['intent-filter'] ?? []).filter(
        (filter) =>
          !(filter.data ?? []).some(
            (data) => data.$?.['android:host'] === 'antigravity.google.com',
          ),
      );
    }
    return mod;
  });
  config = withGradleProperties(config, (mod) => {
    const values = {
      'android.enableMinifyInReleaseBuilds': 'true',
      'android.enableProguardInReleaseBuilds': 'true',
      'android.enableShrinkResourcesInReleaseBuilds': 'true',
      'android.compileSdkVersion': '36',
      'android.targetSdkVersion': '36',
      'android.buildToolsVersion': '36.0.0',
      EX_DEV_CLIENT_NETWORK_INSPECTOR: 'false',
    };
    mod.modResults = mod.modResults.filter(
      (item) => !(item.type === 'property' && item.key in values),
    );
    for (const [key, value] of Object.entries(values))
      mod.modResults.push({ type: 'property', key, value });
    return mod;
  });
  config = withAppBuildGradle(config, (mod) => {
    const statement =
      'apply from: new File(rootDir, "../plugins/android-release.gradle")';
    if (!mod.modResults.contents.includes(statement))
      mod.modResults.contents += `\n${statement}\n`;
    return mod;
  });
  config = withProjectBuildGradle(config, (mod) => {
    const publisher =
      "classpath('com.github.triplet.gradle:play-publisher:3.10.1')";
    if (!mod.modResults.contents.includes(publisher)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n        ${publisher}`,
      );
    }
    return mod;
  });
  config = withMainActivity(config, (mod) => {
    if (mod.modResults.contents.includes(KEYBOARD_TAG)) return mod;
    const anchor = 'super.onCreate(null)';
    if (!mod.modResults.contents.includes(anchor))
      throw new Error(
        'Update the IME plugin for this Expo MainActivity template',
      );
    mod.modResults.contents = mod.modResults.contents.replace(
      anchor,
      `${anchor}

    ${KEYBOARD_TAG}
    val contentView = findViewById<android.view.View>(android.R.id.content)
    androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->
      val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
      val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
      view.setPadding(0, 0, 0, (ime.bottom - bars.bottom).coerceAtLeast(0))
      insets
    }`,
    );
    return mod;
  });
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const folder = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      await fs.mkdir(folder, { recursive: true });
      const exclusions = [
        'root',
        'file',
        'database',
        'sharedpref',
        'external',
        'device_root',
        'device_file',
        'device_database',
        'device_sharedpref',
      ]
        .map((domain) => `    <exclude domain="${domain}" path="."/>`)
        .join('\n');
      await fs.writeFile(
        path.join(folder, 'remote_data_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>\n${exclusions}\n  </cloud-backup>\n  <device-transfer>\n${exclusions}\n  </device-transfer>\n</data-extraction-rules>\n`,
      );
      return mod;
    },
  ]);
};
