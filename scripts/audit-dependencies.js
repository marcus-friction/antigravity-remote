const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { patchBuildTools, forgePatch } = require('./patch-build-tools');

const ROOT = path.resolve(__dirname, '..');

function reviewAudit(report, root = ROOT) {
  if (report.error || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error(report.error?.summary ?? 'Invalid dependency audit report');
  }
  // Verification never applies patches: a missing postinstall is a failure.
  const verified = patchBuildTools(root, true);
  const unexpected = [];
  const backported = new Set();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    for (const advisory of vulnerability.via) {
      if (typeof advisory === 'string') {
        if (!report.vulnerabilities[advisory]) {
          unexpected.push(`Missing audit details for ${advisory}`);
        }
        continue; // The referenced package's advisory is checked separately.
      }
      if (
        name === 'node-forge' &&
        advisory.name === 'node-forge' &&
        advisory.url === `https://github.com/advisories/${forgePatch.advisory}` &&
        advisory.range === '<=1.4.0' &&
        vulnerability.nodes?.length > 0 &&
        vulnerability.nodes.every((location) => verified.has(location))
      ) {
        backported.add(forgePatch.advisory);
      } else {
        unexpected.push(`${advisory.name}: ${advisory.title} (${advisory.url})`);
      }
    }
  }
  return { unexpected, backported };
}

function auditDependencies() {
  const result = spawnSync('npm', [
    'audit', '--json', '--include=dev', '--include=optional', '--include=peer',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Dependency audit failed: ${result.stderr}`);
  }
  const { unexpected, backported } = reviewAudit(JSON.parse(result.stdout));
  if (unexpected.length) {
    throw new Error(unexpected.join('\n'));
  }
  console.log(`No unpatched dependency advisories. ${backported.size} advisory fixed by a verified local backport (npm still reports the original package version).`);
}

if (require.main === module) {
  try {
    auditDependencies();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { reviewAudit };
