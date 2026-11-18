// Offline tests for the pivot table SQL generation pipeline.
//
// The generator is a set of browser <script> files; test/lib/load-generator.js
// loads them into this Node process so they can be exercised without a browser,
// a DuckDB connection, or any network access. All coverage uses the small local
// sample dataset described in test/lib/fixtures.js.
//
// Run with: node test/sql-query-generator.test.js

const assert = require('assert');
const { loadGenerator } = require('./lib/load-generator');
const {
  DATASOURCE,
  rowAxisItem,
  columnAxisItem,
  cellAxisItem,
  withTotals,
  arrayAxisItem,
  filterAxisItem,
  countCtes,
  getCteBody
} = require('./lib/fixtures');

loadGenerator();
const { SqlQueryGenerator } = globalThis;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function generate(options) {
  return SqlQueryGenerator.getSqlSelectStatementForAxisItems(Object.assign({
    datasource: DATASOURCE,
    filterAxisItems: []
  }, options));
}

// Common fixture items -------------------------------------------------------

const amount = cellAxisItem('amount', 'INTEGER', 'sum');
const region = rowAxisItem('region', 'VARCHAR');
const category = columnAxisItem('category', 'VARCHAR');
const tagsElements = arrayAxisItem('rows', 'tags', 'VARCHAR[]', 'elements', ['unnest()']);

// A helper: return the GROUP BY clause of a generated statement.
function getGroupByClause(sql) {
  const match = /GROUP BY ([\s\S]*?)(?:\nORDER BY|$)/.exec(sql);
  return match ? match[1].trim() : undefined;
}

function getWhereClause(sql) {
  const match = /\nWHERE ([\s\S]*?)(?:\nQUALIFY|\nGROUP BY|\nORDER BY|$)/.exec(sql);
  return match ? match[1].trim() : undefined;
}

function getQualifyClause(sql) {
  const match = /\nQUALIFY ([\s\S]*?)(?:\nWHERE|\nGROUP BY|\nORDER BY|$)/.exec(sql);
  return match ? match[1].trim() : undefined;
}

// 1. single unnesting stage + row totals -------------------------------------

test('single unnest + row totals: one expansion CTE, grouping sets and GROUPING_ID', () => {
  const sql = generate({
    totalsPosition: 'AFTER',
    queryAxisItems: [tagsElements, withTotals(region), amount]
  });

  // Exactly one CTE: the expansion step for the array column. There is no
  // extra CTE for the aggregate/final stage.
  assert.strictEqual(countCtes(sql), 1, 'expected exactly one CTE');

  const expansionBody = getCteBody(sql, '__huey_data_foundation');
  assert.ok(expansionBody, 'expected the data foundation CTE');
  assert.ok(
    expansionBody.includes('unnest( case len( coalesce( __huey_data_foundation.tags, []) )'),
    'expected the unnest() expansion expression in the CTE'
  );
  assert.ok(
    expansionBody.includes('AS "tags.unnest()"'),
    'expected the unnested column to be aliased after its expression'
  );
  assert.ok(
    !expansionBody.includes('generate_subscripts('),
    'should not emit generate_subscripts() when only unnest() is used'
  );
  assert.ok(
    !expansionBody.includes('GROUPING'),
    'the expansion CTE should not contain grouping logic'
  );

  // The final SELECT must reference the unnested column, not the array column.
  assert.ok(sql.includes('cte2."tags.unnest()" AS "tags.elements"'));
  assert.ok(!/cte2\.tags\b/.test(sql), 'the array column must not be referenced after expansion');

  // Row totals produce a grouping set that includes all preceding row items
  // (here, just the unnested item) and one for the full detail combination.
  const groupBy = getGroupByClause(sql);
  assert.ok(groupBy.startsWith('GROUPING SETS('), 'expected GROUPING SETS');
  assert.ok(groupBy.includes('"tags.elements"'), 'expected the unnested item in a grouping set');
  assert.ok(
    /\(\s*"tags\.elements"\s*,\s*region\s*\)/.test(groupBy),
    'expected a grouping set containing both detail columns'
  );

  // GROUPING_ID over the totals column, aliased as the tuple set expects.
  assert.ok(/GROUPING_ID\(\s*cte2\.region\s*\) AS __huey_grouping_id/.test(sql));

  // totalsPosition AFTER sorts detail rows before their totals.
  assert.ok(
    /\nORDER BY "tags\.elements" ASC\n,__huey_grouping_id & 1 ASC\n,region ASC$/.test(sql),
    'expected totals to sort after detail rows'
  );
});

test('single unnest + row totals: totalsPosition BEFORE puts totals first', () => {
  const sql = generate({
    totalsPosition: 'BEFORE',
    queryAxisItems: [tagsElements, withTotals(region), amount]
  });
  assert.ok(
    /,__huey_grouping_id & 1 DESC/.test(sql),
    'expected descending grouping-id sort so totals precede detail'
  );
});

// 2. no unnest, no totals ----------------------------------------------------

test('no unnest, no totals: no CTE and a plain GROUP BY', () => {
  const sql = generate({
    queryAxisItems: [region, amount]
  });

  assert.strictEqual(countCtes(sql), 0, 'no expansion is needed, so no CTE may be emitted');
  assert.ok(!sql.includes('unnest('), 'no unnest() should be generated');
  assert.ok(!sql.includes('GROUPING SETS'), 'no grouping sets without totals');
  assert.ok(!sql.includes('GROUPING_ID'), 'no grouping id without totals');
  assert.strictEqual(getGroupByClause(sql), 'region');
  assert.ok(sql.endsWith('ORDER BY region ASC'));
});

test('no unnest, no totals: column axis items are grouped too', () => {
  const sql = generate({
    queryAxisItems: [region, category, amount]
  });
  assert.strictEqual(countCtes(sql), 0);
  assert.strictEqual(getGroupByClause(sql), 'region\n,category');
});

// 3. filter pushed down onto the expansion path ------------------------------

test('filter on an unnested path is pushed down to the expansion layer, not left on the array', () => {
  const sql = generate({
    queryAxisItems: [tagsElements, region, amount],
    filterAxisItems: [
      filterAxisItem('tags', 'VARCHAR[]', ['unnest()'], 'elements', "'a'")
    ]
  });

  assert.strictEqual(countCtes(sql), 1, 'the filter needs exactly one expansion CTE');

  const expansionBody = getCteBody(sql, '__huey_data_foundation');
  assert.ok(
    expansionBody.includes('unnest('),
    'the expansion CTE should project the unnested element'
  );

  // With a single expansion level, the only stage that can see the unnested
  // values is the query directly above the expansion CTE (DuckDB does not
  // allow filtering an unnest() in the same SELECT that produces it).
  const where = getWhereClause(sql);
  assert.ok(where, 'expected a WHERE clause after the expansion');
  assert.ok(
    where.includes('"tags.unnest()" = \'a\''),
    'the filter should reference the unnested column, not the array column'
  );
  assert.ok(
    !/WHERE[\s\S]*__huey_data_foundation\.tags\b/.test(sql),
    'the filter must not stay on the array column'
  );
  // The filter must be applied to expanded values, so it may not appear in the
  // final GROUP BY / select list stage against the raw array either.
  assert.ok(
    !/WHERE[\s\S]*\btags\b\s*=/.test(sql.replace(/"tags\.unnest\(\)"/g, '')),
    'the raw array column must not be compared against an element value'
  );
});

test('filter on a nested path lands in the CTE for that expansion level', () => {
  const matrixElements = arrayAxisItem(
    'rows', 'matrix', 'INTEGER[][]', 'elements', ['unnest()', 'unnest()'], { caption: 'matrix.elements' }
  );
  const sql = generate({
    queryAxisItems: [matrixElements, amount],
    filterAxisItems: [
      filterAxisItem('matrix', 'INTEGER[][]', ['unnest()'], 'elements', '1')
    ]
  });

  // Two expansion levels -> two CTEs.
  assert.strictEqual(countCtes(sql), 2, 'expected one CTE per expansion level');

  const level2Body = getCteBody(sql, 'cte2');
  assert.ok(level2Body, 'expected the second expansion CTE');
  assert.ok(
    level2Body.includes('"matrix.unnest()" = 1'),
    'filter on the first-level element should be applied at the second expansion stage'
  );
  assert.ok(
    !sql.includes('cte3."matrix.unnest()" = 1'),
    'the filter must not be pushed to the outermost stage'
  );
});

test('filter that targets an array element forces an expansion CTE even without axis unnesting', () => {
  const sql = generate({
    queryAxisItems: [region, amount],
    filterAxisItems: [
      filterAxisItem('tags', 'VARCHAR[]', ['unnest()'], 'elements', "'a'")
    ]
  });

  assert.strictEqual(countCtes(sql), 1, 'the filter requires an expansion CTE');
  const body = getCteBody(sql, '__huey_data_foundation');
  assert.ok(body.includes('unnest('), 'expected the array to be expanded');
  assert.ok(
    body.includes('"tags.unnest()"'),
    'expected the unnested element to be projected so the filter can use it'
  );
  assert.ok(
    getWhereClause(sql).includes('"tags.unnest()" = \'a\''),
    'expected the filter to run against the unnested element'
  );
});

// 4. filters on aggregated results use QUALIFY -------------------------------

test('filter on an aggregate becomes QUALIFY, not WHERE', () => {
  const aggregateFilter = {
    axis: 'filters',
    columnName: 'amount',
    columnType: 'INTEGER',
    aggregator: 'sum',
    caption: 'Sum of amount',
    partitionByItems: [region],
    filter: { filterType: 'in', values: { 100: { label: '100', literal: '100', enabled: true } } }
  };
  const sql = generate({
    queryAxisItems: [region, amount],
    filterAxisItems: [aggregateFilter]
  });

  const qualify = getQualifyClause(sql);
  assert.ok(qualify, 'expected a QUALIFY clause');
  assert.ok(
    qualify.includes('SUM( __huey_data_foundation.amount ) OVER ( PARTITION BY __huey_data_foundation.region ) = 100'),
    'expected the window aggregate in the QUALIFY condition'
  );
  assert.strictEqual(getWhereClause(sql), undefined, 'aggregate filters must not become WHERE');
});

// 5. wrapping the final stage as a CTE ---------------------------------------

test('finalStateAsCte wraps the final stage in a named CTE that can be referenced', () => {
  const sql = generate({
    finalStateAsCte: true,
    cteName: '__huey_cells',
    totalsPosition: 'AFTER',
    queryAxisItems: [tagsElements, withTotals(region), amount]
  });

  // The expansion CTE plus the final-state CTE.
  assert.strictEqual(countCtes(sql), 2, 'expected the expansion CTE and the final-state CTE');
  const cellsBody = getCteBody(sql, '__huey_cells');
  assert.ok(cellsBody, 'expected the final stage to be named __huey_cells');
  assert.ok(cellsBody.includes('GROUPING SETS('), 'the final stage keeps its grouping sets');
  assert.ok(
    !/\nSELECT[\s\S]*$/.test(sql.slice(sql.lastIndexOf(')') + 1)),
    'nothing but whitespace may follow the CTE list'
  );
  // The result is a fragment: a caller appends its own comma-separated CTEs and
  // query. Confirm it parses as the start of a WITH-clause.
  assert.ok(/^WITH /.test(sql), 'expected a WITH-clause');
});

// 6. empty axis --------------------------------------------------------------

test('empty axis (no query items) returns undefined', () => {
  assert.strictEqual(
    SqlQueryGenerator.getSqlSelectStatementForAxisItems({
      datasource: DATASOURCE,
      queryAxisItems: [],
      filterAxisItems: []
    }),
    undefined
  );
});

// 7. additive coverage: both expansion functions, columns axis, guards --------

test('both unnesting functions at one level are generated in a single CTE', () => {
  const tagIndices = arrayAxisItem(
    'rows', 'tags', 'VARCHAR[]', 'element indices', ['generate_subscripts()'], { caption: 'tags.indices' }
  );
  const sql = generate({ queryAxisItems: [tagsElements, tagIndices, amount] });

  assert.strictEqual(countCtes(sql), 1, 'both functions expand the same array at the same level');
  const body = getCteBody(sql, '__huey_data_foundation');
  assert.ok(body.includes('unnest('), 'expected unnest()');
  assert.ok(body.includes('generate_subscripts('), 'expected generate_subscripts()');
});

test('totals on the columns axis generate grouping sets over the column items', () => {
  const sql = generate({
    totalsPosition: 'AFTER',
    queryAxisItems: [withTotals(region), withTotals(category), amount]
  });
  const groupBy = getGroupByClause(sql);
  assert.ok(groupBy.includes('GROUPING SETS('));
  assert.ok(/\(\s*category\s*\)/.test(groupBy), 'expected a column-only totals grouping set');
  assert.ok(/\(\s*region\s*\)/.test(groupBy), 'expected a row-only totals grouping set');
  assert.ok(/\(\s*region\s*,\s*category\s*\)/.test(groupBy), 'expected the detail grouping set');
});

test('the generator does not mutate the query items it is given', () => {
  const items = [tagsElements, withTotals(region), amount];
  const snapshot = JSON.stringify(items);
  generate({ totalsPosition: 'AFTER', queryAxisItems: items });
  assert.strictEqual(JSON.stringify(items), snapshot, 'input query items must be left untouched');
});

// Runner --------------------------------------------------------------------

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  }
  catch (e) {
    failures += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${e.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
if (failures) {
  process.exitCode = 1;
}
