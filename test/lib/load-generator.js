// Loads the browser scripts that make up the pivot-table SQL generation
// pipeline so they can be exercised offline from Node.
//
// The scripts are plain <script> files: functions become globals by virtue of
// being top-level function declarations, while the `class` declarations have
// to be re-exported explicitly after their script is evaluated. Each file is
// evaluated with its real filename so stack traces stay readable, and all
// files share the host realm so `instanceof Array` keeps working.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_FILES = [
  { file: 'src/util/sql/SQLHelper.js' },
  { file: 'src/QueryModel/QueryAxisItem.js', exportClass: 'QueryAxisItem' },
  { file: 'src/DataSet/SqlQueryGenerator.js', exportClass: 'SqlQueryGenerator' }
];

let loaded = false;

function loadGenerator() {
  require('./stubs');
  if (loaded) {
    return globalThis;
  }
  for (const { file, exportClass } of SOURCE_FILES) {
    const filename = path.join(REPO_ROOT, file);
    let source = fs.readFileSync(filename, 'utf8');
    if (exportClass) {
      source += `\nglobalThis.${exportClass} = ${exportClass};\n`;
    }
    vm.runInThisContext(source, { filename });
  }
  loaded = true;
  return globalThis;
}

module.exports = { loadGenerator, REPO_ROOT };
