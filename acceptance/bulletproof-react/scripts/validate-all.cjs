#!/usr/bin/env node
// Validate every *.appmap.json under the given directories with the official
// validator (@appland/appmap-validate, getappmap/appmap-js packages/validate),
// once against the version each file declares and once against every spec
// version from 1.2.0 up. Prints a JSON report on stdout.
//
// usage: node validate-all.cjs <validatorModuleDir> <dir>...
const { readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');

const [validatorDir, ...dirs] = process.argv.slice(2);
const { validate } = require(join(validatorDir, 'lib', 'index.js'));

const VERSIONS = [
  // (the official validator ships no 1.4.1 schema, so 1.4.1 is not listed)
  '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.5.1', '1.6.0', '1.7.0',
  '1.8.0', '1.9.0', '1.10.0', '1.11.0', '1.12.0', '1.13.0', '1.13.1',
];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.appmap.json') ? [p] : [];
  });

const firstLine = (err) => String(err && err.message).split('\n').slice(0, 6).join(' | ');

const report = { files: [] };
for (const dir of dirs) {
  for (const file of walk(dir)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const entry = {
      file,
      declared: data.version,
      declaredResult: null,
      perVersion: {},
      // DIAGNOSTIC ONLY, never a pass: the same check on a copy where the one
      // known-missing field (metadata.frameworks[].version) is filled in, to
      // show which other failures it hides.
      perVersionIfFrameworksVersionPatched: {},
    };
    const patched = {
      ...data,
      metadata: {
        ...data.metadata,
        ...(Array.isArray(data.metadata?.frameworks)
          ? { frameworks: data.metadata.frameworks.map((f) => ({ version: 'unknown', ...f })) }
          : {}),
      },
    };
    try {
      validate(data, {});
      entry.declaredResult = 'valid';
    } catch (err) {
      entry.declaredResult = `INVALID: ${firstLine(err)}`;
    }
    for (const version of VERSIONS) {
      try {
        // Each schema pins `version` to its own value, so ask "would this
        // content be valid if it declared <version>?" on a relabeled copy.
        validate({ ...data, version }, { version });
        entry.perVersion[version] = 'valid';
      } catch (err) {
        entry.perVersion[version] = `INVALID: ${firstLine(err)}`;
      }
      try {
        validate({ ...patched, version }, { version });
        entry.perVersionIfFrameworksVersionPatched[version] = 'valid';
      } catch (err) {
        entry.perVersionIfFrameworksVersionPatched[version] = `INVALID: ${firstLine(err)}`;
      }
    }
    report.files.push(entry);
  }
}
report.summary = {
  files: report.files.length,
  declaredValid: report.files.filter((f) => f.declaredResult === 'valid').length,
  perVersionAllValid: Object.fromEntries(
    VERSIONS.map((v) => [v, report.files.filter((f) => f.perVersion[v] === 'valid').length]),
  ),
  diagnosticIfFrameworksVersionPatched: Object.fromEntries(
    VERSIONS.map((v) => [
      v,
      report.files.filter((f) => f.perVersionIfFrameworksVersionPatched[v] === 'valid').length,
    ]),
  ),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
