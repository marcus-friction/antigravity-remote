import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { validateNavigationUrl } from '../src/utils/urlValidator';

it('lets the application reject schemes before the installed WebView can dispatch to the OS', async () => {
  // Exercise the real WebView wrapper: direct callback mocks miss its automatic
  // external-scheme handling when originWhitelist does not match a URL.
  const filename = path.join(
    path.dirname(require.resolve('react-native-webview/package.json')),
    'src/WebViewShared.tsx',
  );
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const openURL = jest.fn(async () => true);
  const moduleObject = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module: moduleObject,
    exports: moduleObject.exports,
    console,
    require: (name: string) =>
      name === 'react-native'
        ? { Linking: { openURL, canOpenURL: async () => true } }
        : name === './WebView.styles'
          ? {}
          : require(name),
  });
  const policy = jest.fn(
    (request) => validateNavigationUrl(request.url).isAllowedInApp,
  );
  const decision = jest.fn();
  const onRequest = moduleObject.exports.createOnShouldStartLoadWithRequest(
    decision,
    ['*'],
    policy,
  );
  for (const url of [
    'http://example.com',
    'intent://example.com',
    'file:///tmp/private',
  ]) {
    onRequest({ nativeEvent: { url, lockIdentifier: 1 } });
  }
  await Promise.resolve();
  expect(policy).toHaveBeenCalledTimes(3);
  expect(openURL).not.toHaveBeenCalled();
  expect(decision.mock.calls.every((call) => call[0] === false)).toBe(true);
});
