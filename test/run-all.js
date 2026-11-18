// Runs every offline test in this directory. No network, no browser, no
// external datasource: the tests use the local sample data from
// test/lib/fixtures.js.
//
//   node test/run-all.js
//
const childProcess = require('child_process');
const path = require('path');

const suites = [
  'sql-query-generator.test.js',
  'execute-generated-sql.js'
];

let failed = false;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, suite)],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
