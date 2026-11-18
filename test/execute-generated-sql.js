// Optional end-to-end check: run the SQL produced by the generator against the
// local sample dataset in DuckDB.
//
// This is intentionally separate from the unit tests: it needs a Python
// interpreter with the `duckdb` module, which may not be installed. When that
// is unavailable the check reports that it was skipped and exits 0. No network
// access and no external datasource are involved: the sample data is created
// from literals in test/lib/fixtures.js.
//
// Run with: node test/execute-generated-sql.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { loadGenerator } = require('./lib/load-generator');
const {
  DATASOURCE,
  SAMPLE_DATA_DUCKDB,
  rowAxisItem,
  columnAxisItem,
  cellAxisItem,
  withTotals,
  arrayAxisItem,
  filterAxisItem
} = require('./lib/fixtures');

function findPython() {
  const candidates = ['python', 'python3', 'py'];
  for (const candidate of candidates) {
    try {
      const result = childProcess.spawnSync(candidate, ['-c', 'import duckdb'], {
        encoding: 'utf8',
        timeout: 30000
      });
      if (result.status === 0) {
        return candidate;
      }
    }
    catch (e) {
      // try the next candidate
    }
  }
  return undefined;
}

const python = findPython();
if (!python) {
  console.log('skipped: no Python interpreter with the duckdb module was found');
  console.log('(the SQL assertions in test/sql-query-generator.test.js still apply)');
  process.exit(0);
}

loadGenerator();
const { SqlQueryGenerator } = globalThis;

const amount = cellAxisItem('amount', 'INTEGER', 'sum');
const region = rowAxisItem('region', 'VARCHAR');
const tagsElements = arrayAxisItem('rows', 'tags', 'VARCHAR[]', 'elements', ['unnest()']);

function generate(options) {
  return SqlQueryGenerator.getSqlSelectStatementForAxisItems(Object.assign({
    datasource: DATASOURCE,
    filterAxisItems: []
  }, options));
}

// Each case: a local sample table, the generated SQL, and the expected number
// of result rows. Matrix cases run against the array-of-array sample table.
const cases = {
  'single unnest + row totals': {
    table: 'sales',
    sql: generate({
      totalsPosition: 'AFTER',
      queryAxisItems: [tagsElements, withTotals(region), amount]
    }),
    rows: 7
  },
  'no unnest, no totals': {
    table: 'sales',
    sql: generate({ queryAxisItems: [region, amount] }),
    rows: 2
  },
  'rows and columns totals': {
    table: 'sales',
    sql: generate({
      totalsPosition: 'AFTER',
      queryAxisItems: [withTotals(region), withTotals(columnAxisItem('category', 'VARCHAR')), amount]
    }),
    rows: 9
  },
  'filter pushed to the expansion layer': {
    table: 'sales',
    sql: generate({
      queryAxisItems: [tagsElements, region, amount],
      filterAxisItems: [filterAxisItem('tags', 'VARCHAR[]', ['unnest()'], 'elements', "'a'")]
    }),
    rows: 2
  },
  'nested expansion': {
    table: 'matrix_sales',
    sql: generate({
      queryAxisItems: [
        arrayAxisItem('rows', 'matrix', 'INTEGER[][]', 'elements', ['unnest()', 'unnest()'],
          { caption: 'matrix.elements' }),
        amount
      ]
    }),
    rows: 4
  },
  'filter on an aggregate uses QUALIFY': {
    table: 'sales',
    sql: generate({
      queryAxisItems: [region, amount],
      filterAxisItems: [{
        axis: 'filters',
        columnName: 'region',
        columnType: 'VARCHAR',
        aggregator: 'count',
        caption: 'Count of region',
        partitionByItems: [region],
        filter: { filterType: 'in', values: { 2: { label: '2', literal: '2', enabled: true } } }
      }]
    }),
    rows: 2
  }
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huey-sqlgen-'));
const sqlFile = path.join(workDir, 'cases.json');
const scriptFile = path.join(workDir, 'run.py');

fs.writeFileSync(sqlFile, JSON.stringify(cases));
fs.writeFileSync(scriptFile, [
  'import json, sys',
  'import duckdb',
  'cases = json.load(open(sys.argv[1]))',
  'con = duckdb.connect()',
  'con.sql("""' + SAMPLE_DATA_DUCKDB + '""")',
  'failures = []',
  'for name, case in cases.items():',
  '    sql = case["sql"].replace(\'FROM "sales"\', \'FROM "%s"\' % case["table"])',
  '    try:',
  '        rows = con.sql(sql).df()',
  '        actual = len(rows)',
  '        status = "ok" if actual == case["rows"] else "FAIL"',
  '        print("%s   %s: %d rows (expected %d)" % (status, name, actual, case["rows"]))',
  '        if status == "FAIL":',
  '            failures.append(name)',
  '    except Exception as e:',
  '        print("FAIL   %s: %s" % (name, e))',
  '        failures.append(name)',
  'sys.exit(1 if failures else 0)'
].join('\n'));

const result = childProcess.spawnSync(python, ['-I', scriptFile, sqlFile], {
  encoding: 'utf8'
});
process.stdout.write(result.stdout || '');
if (result.stderr) {
  process.stderr.write(result.stderr);
}
fs.rmSync(workDir, { recursive: true, force: true });
assert.ok(result.status === 0, 'generated SQL failed to execute against the sample data');
