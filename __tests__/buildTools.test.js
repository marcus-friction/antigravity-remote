const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { patchBuildTools, forgePatch } = require('../scripts/patch-build-tools');
const { reviewAudit } = require('../scripts/audit-dependencies');

const cliRequire = createRequire(require.resolve('@expo/cli/package.json', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
}));
const { z } = cliRequire('zod');
const { PluginSchema, DevToolsPluginOutputSchema } = cliRequire('./build/src/start/server/DevToolsPlugin.schema');
const { createMCPDevToolsExtensionSchema } = cliRequire('./build/src/start/server/createMCPDevToolsExtensionSchema');
const { DevToolsPluginCliExtensionResults } = cliRequire('./build/src/start/server/DevToolsPluginCliExtensionResults');
const forge = cliRequire('node-forge');

describe('node-forge RSA security backport', () => {
  let keyPair;
  let digest;
  const { asn1 } = forge;
  const node = (type, value, constructed = false) =>
    asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  const sequence = (value) => node(asn1.Type.SEQUENCE, value, true);
  const oid = () => node(asn1.Type.OID, asn1.oidToDer(forge.oids.sha256).getBytes());
  const nil = () => node(asn1.Type.NULL, '');
  const garbage = () => node(asn1.Type.OCTETSTRING, 'unconsumed data');

  beforeAll(() => {
    // Low public exponent exercises the advisory's affected RSA key class.
    const pem = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 3,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    keyPair = {
      privateKey: forge.pki.privateKeyFromPem(pem.privateKey),
      publicKey: forge.pki.publicKeyFromPem(pem.publicKey),
    };
    digest = forge.md.sha256.create().update('security regression').digest().getBytes();
  });

  function signDigestInfo(algorithm, extra = []) {
    const info = sequence([
      sequence(algorithm),
      node(asn1.Type.OCTETSTRING, digest),
      ...extra,
    ]);
    // Sign arbitrary DigestInfo with real PKCS#1 padding, bypassing the encoder.
    return keyPair.privateKey.sign(asn1.toDer(info).getBytes(), 'NONE');
  }

  test.each([
    ['OID and NULL plus garbage', () => [oid(), nil(), garbage()]],
    ['OID plus non-NULL parameters', () => [oid(), garbage()]],
    ['OID plus duplicate NULL', () => [oid(), nil(), nil()]],
  ])('rejects nested %s (accepted by unpatched 1.4.0)', (_name, algorithm) => {
    expect(() => keyPair.publicKey.verify(digest, signDigestInfo(algorithm())))
      .toThrow(/valid RSASSA-PKCS1-v1_5 DigestInfo/);
  });

  test.each([
    ['with NULL', () => [oid(), nil()]],
    ['without optional NULL', () => [oid()]],
  ])('accepts valid SHA-256 DigestInfo %s', (_name, algorithm) => {
    const signature = signDigestInfo(algorithm());
    expect(keyPair.publicKey.verify(digest, signature)).toBe(true);
    expect(keyPair.publicKey.verify('incorrect digest', signature)).toBe(false);
  });

  test('still rejects extra outer DigestInfo elements', () => {
    expect(() => keyPair.publicKey.verify(digest, signDigestInfo([oid(), nil()], [garbage()])))
      .toThrow(/valid RSASSA-PKCS1-v1_5 DigestInfo/);
  });

  test('Expo certificate creation, validation, and manifest signing still work', () => {
    const certificates = cliRequire('@expo/code-signing-certificates');
    const certificate = certificates.generateSelfSignedCodeSigningCertificate({
      keyPair,
      validityNotBefore: new Date(Date.now() - 60_000),
      validityNotAfter: new Date(Date.now() + 3_600_000),
      commonName: 'build-tool regression fixture',
    });
    expect(() => certificates.validateSelfSignedCertificate(certificate, keyPair)).not.toThrow();
    const message = Buffer.from('test manifest');
    const signature = certificates.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, message);
    expect(crypto.verify('sha256', message, forge.pki.publicKeyToPem(keyPair.publicKey), Buffer.from(signature, 'base64')))
      .toBe(true);
  });
});

describe('Expo CLI compatibility with patched Zod', () => {
  const plugin = {
    packageName: 'fixture',
    packageRoot: '/tmp/fixture',
    cliExtensions: {
      description: 'Fixture extension',
      entryPoint: './tool.js',
      commands: [{
        name: 'check',
        title: 'Check',
        environments: ['cli', 'mcp'],
        parameters: [
          { name: 'count', type: 'number' },
          { name: 'accepted', type: 'confirm' },
          { name: 'label', type: 'text' },
        ],
      }],
    },
  };

  test('rejects oversized arrays before parsing any elements', () => {
    let visits = 0;
    const schema = z.array(z.string().refine(() => { visits++; return false; })).max(2);
    const result = schema.safeParse(Array(10_000).fill('invalid'));
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].code).toBe('too_big');
    expect(visits).toBe(0);
  });

  test('validates plugin metadata, strips unknown keys, and preserves readonly environments', () => {
    const parsed = PluginSchema.parse({ ...plugin, unknown: 'discard' });
    expect(parsed).toEqual(plugin);
    expect(Object.isFrozen(parsed.cliExtensions.commands[0].environments)).toBe(true);
    expect(PluginSchema.safeParse({ ...plugin, packageName: '' }).success).toBe(false);
    expect(PluginSchema.safeParse({
      ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] },
    }).success).toBe(false);
    expect(PluginSchema.safeParse({
      ...plugin,
      cliExtensions: { ...plugin.cliExtensions, commands: [{ ...plugin.cliExtensions.commands[0], environments: ['invalid'] }] },
    }).success).toBe(false);
  });

  test('parses text/audio/image output and returns usable validation errors', () => {
    const output = [
      { type: 'text', text: 'ok', level: 'info' },
      { type: 'audio', url: 'https://example.com/audio' },
      { type: 'image', url: 'https://example.com/image', text: 'image' },
    ];
    expect(DevToolsPluginOutputSchema.parse(output)).toEqual(output);
    const results = new DevToolsPluginCliExtensionResults();
    expect(results.parseOutputText(JSON.stringify(output))).toEqual(output);
    expect(results.parseOutputText('[{"type":"image","url":"invalid"}]')[0])
      .toMatchObject({ type: 'text', level: 'error', text: expect.stringContaining('Invalid JSON') });
    expect(results.parseOutputText('plain output')[0]).toMatchObject({ text: 'plain output' });
  });

  test('MCP schemas validate command parameters and convert to strict JSON Schema', () => {
    const schema = createMCPDevToolsExtensionSchema(plugin);
    expect(schema.parse({ command: 'check', count: 2, accepted: true, label: 'ok' }))
      .toEqual({ command: 'check', count: 2, accepted: true, label: 'ok' });
    expect(schema.safeParse({ command: 'check' }).success).toBe(true);
    for (const invalid of [{}, { command: 'unknown' }, { command: 'check', extra: 1 }, { command: 'check', count: '2' }]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    const json = z.toJSONSchema(schema);
    expect(json).toMatchObject({
      type: 'object', additionalProperties: false, required: ['command'],
      properties: {
        command: { enum: ['check'] }, count: { type: 'number' },
        accepted: { type: 'boolean' }, label: { type: 'string' },
      },
    });
    expect(() => createMCPDevToolsExtensionSchema({ packageName: 'empty' })).toThrow(/no commands/);
  });
});

describe('backport installation and dependency audit enforcement', () => {
  const location = 'node_modules/node-forge';
  let temporary;
  const installedSource = fs.readFileSync(cliRequire.resolve('node-forge/lib/rsa.js'), 'utf8');
  const unpatchedSource = installedSource.replace(forgePatch.after, forgePatch.before);
  const advisory = {
    name: 'node-forge', title: 'RSA signature forgery', range: '<=1.4.0',
    url: `https://github.com/advisories/${forgePatch.advisory}`,
  };
  const report = () => ({
    metadata: { vulnerabilities: { high: 1 } },
    vulnerabilities: {
      expo: { via: ['node-forge'] },
      'node-forge': { via: [advisory], nodes: [location] },
    },
  });
  const write = (file, contents) => {
    const filename = path.join(temporary, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  };

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-backport-'));
    write('package-lock.json', JSON.stringify({ packages: { [location]: { version: '1.4.0' } } }));
    write(`${location}/package.json`, JSON.stringify({ name: 'node-forge', version: '1.4.0' }));
    write(`${location}/lib/rsa.js`, unpatchedSource);
  });
  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  test('requires installation of the patch and applies it idempotently', () => {
    expect(() => patchBuildTools(temporary, true)).toThrow(/Unverified/);
    patchBuildTools(temporary);
    expect(patchBuildTools(temporary, true)).toEqual(new Set([location]));
    patchBuildTools(temporary);
    expect(fs.readFileSync(path.join(temporary, location, 'lib/rsa.js'), 'utf8')).toBe(installedSource);
    expect(reviewAudit(report(), temporary)).toEqual({ unexpected: [], backported: new Set([forgePatch.advisory]) });
  });

  test('fails audit when postinstall was skipped and refuses unknown source code', () => {
    expect(() => reviewAudit(report(), temporary)).toThrow(/Unverified/);
    write(`${location}/lib/rsa.js`, `${unpatchedSource}\n// modified\n`);
    expect(() => patchBuildTools(temporary)).toThrow(/Unverified/);
  });

  test('rechecks all nested copies and rejects upgrades that need reassessment', () => {
    patchBuildTools(temporary);
    const nested = 'node_modules/other/node_modules/node-forge';
    write('package-lock.json', JSON.stringify({ packages: {
      [location]: { version: '1.4.0' }, [nested]: { version: '1.4.0' },
    } }));
    write(`${nested}/package.json`, JSON.stringify({ version: '1.4.0' }));
    write(`${nested}/lib/rsa.js`, unpatchedSource);
    expect(() => patchBuildTools(temporary, true)).toThrow(/Unverified/);
    expect(patchBuildTools(temporary)).toEqual(new Set([location, nested]));
    write(`${nested}/package.json`, JSON.stringify({ version: '1.4.1' }));
    expect(() => patchBuildTools(temporary)).toThrow(/Unexpected node-forge version/);
  });

  test('new advisories, expanded affected ranges, and unverified paths fail audit', () => {
    patchBuildTools(temporary);
    for (const change of [
      { url: 'https://github.com/advisories/GHSA-new-advisory' },
      { range: '<=1.4.1' },
    ]) {
      const changed = report();
      changed.vulnerabilities['node-forge'].via = [{ ...advisory, ...change }];
      expect(reviewAudit(changed, temporary).unexpected).toHaveLength(1);
    }
    const unknownPath = report();
    unknownPath.vulnerabilities['node-forge'].nodes.push('node_modules/unverified/node_modules/node-forge');
    expect(reviewAudit(unknownPath, temporary).unexpected).toHaveLength(1);
    expect(() => reviewAudit({ error: { summary: 'registry unavailable' } }, temporary)).toThrow(/registry unavailable/);
  });
});
