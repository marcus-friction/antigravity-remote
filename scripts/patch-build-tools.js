const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

// Backport only lib/rsa.js from https://github.com/digitalbazaar/forge/pull/1152.
// Keep the upstream version: npm audit must still identify this dependency.
const forgePatch = {
  advisory: 'GHSA-86w9-cpqp-85rv',
  version: '1.4.0',
  originalSha256: 'fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50',
  patchedSha256: 'acc22e5d36e27832c34e02dd3933aad7977d45b047eead5016520735efedc9c5',
  before: `          // validate DigestInfo structure and element count
          var capture = {};
          var errors = [];
          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2) {`,
  after: `          // validate DigestInfo structure and element counts (outer DigestInfo
          // and nested DigestAlgorithm). asn1.validate ignores extra children,
          // so length must be checked explicitly at each nesting level to
          // prevent low-exponent PKCS#1 v1.5 signature forgery (CVE-2026-85393).
          var capture = {};
          var errors = [];
          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2 ||
            obj.value[0].value.length !==
              (('parameters' in capture) ? 2 : 1)) {`,
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function patchBuildTools(root = ROOT, checkOnly = false) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const packages = Object.entries(lock.packages ?? {}).filter(([location]) =>
    /(^|\/)node_modules\/node-forge$/.test(location),
  );
  if (packages.length === 0) {
    throw new Error('node-forge is absent from the lockfile; reassess/remove its security backport.');
  }
  const verified = new Set();
  for (const [location, locked] of packages) {
    const directory = path.join(root, location);
    const installed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (locked.version !== forgePatch.version || installed.version !== forgePatch.version) {
      throw new Error(`Unexpected node-forge version at ${location}; reassess its security backport.`);
    }
    const filename = path.join(directory, 'lib/rsa.js');
    const source = fs.readFileSync(filename, 'utf8');
    const hash = sha256(source);
    if (hash !== forgePatch.patchedSha256) {
      if (checkOnly || hash !== forgePatch.originalSha256) {
        throw new Error(`Unverified node-forge RSA implementation at ${location}. Run npm install; do not bypass this check.`);
      }
      const patched = source.replace(forgePatch.before, forgePatch.after);
      if (sha256(patched) !== forgePatch.patchedSha256) {
        throw new Error(`node-forge security backport did not match ${location}.`);
      }
      fs.writeFileSync(filename, patched);
    }
    verified.add(location);
  }
  return verified;
}

if (require.main === module) {
  try {
    const verified = patchBuildTools(ROOT, process.argv.includes('--check'));
    console.log(`Verified ${forgePatch.advisory} backport in ${verified.size} node-forge installation(s).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchBuildTools, forgePatch };
