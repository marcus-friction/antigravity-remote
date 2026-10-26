const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkNative } = require('./check-native');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'antigravity-prebuild-'),
);
try {
  for (const file of [
    'app.json',
    'package.json',
    'package-lock.json',
    'index.ts',
    'App.tsx',
    'assets',
    'plugins',
    'modules',
  ]) {
    fs.cpSync(path.join(root, file), path.join(temporary, file), {
      recursive: true,
    });
  }
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(temporary, 'node_modules'),
    'dir',
  );
  for (const clean of [true, false]) {
    execFileSync(
      process.execPath,
      [
        path.join(root, 'node_modules/expo/bin/cli'),
        'prebuild',
        temporary,
        '--platform',
        'android',
        '--no-install',
        ...(clean ? ['--clean'] : []),
      ],
      {
        env: {
          ...process.env,
          CI: '1',
          __UNSAFE_EXPO_HOME_DIRECTORY: path.join(temporary, '.expo-home'),
        },
        stdio: 'pipe',
      },
    );
    checkNative(temporary);
  }
  console.log(
    'Clean and incremental prebuild preserve native security, signing and IME configuration',
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
