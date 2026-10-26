const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const accepted = JSON.parse(
  fs.readFileSync(path.join(root, 'dependency-advisories.json'), 'utf8'),
);
const result = spawnSync('npm', ['audit', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
if (report.error || result.status > 1)
  throw new Error(report.error?.summary ?? 'Dependency audit failed');
const unexpected = [];
const known = new Set();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const advisory of vulnerability.via) {
    if (typeof advisory === 'string') continue; // Its package entry is checked separately.
    const id = advisory.url.split('/').pop();
    const acceptance = accepted[id];
    if (
      !acceptance ||
      acceptance.package !== advisory.name ||
      Date.now() >= Date.parse(`${acceptance.reviewBy}T23:59:59Z`)
    ) {
      unexpected.push(`${advisory.name}: ${advisory.title} (${advisory.url})`);
    } else known.add(id);
  }
}
if (unexpected.length) {
  console.error(unexpected.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Dependency audit checked all packages; ${known.size} documented upstream advisories remain under temporary acceptance.`,
  );
}
