// Builders for query axis items and small, self-contained sample datasets.
// Everything here is local: no datasource is opened and no network is used.

const DATASOURCE = {
  // The generators only ever ask the datasource for its FROM clause.
  getFromClauseSql() {
    return 'FROM "sales"';
  }
};

function rowAxisItem(columnName, columnType, extra) {
  return Object.assign({ axis: 'rows', columnName, columnType, caption: columnName }, extra);
}

function columnAxisItem(columnName, columnType, extra) {
  return Object.assign({ axis: 'columns', columnName, columnType, caption: columnName }, extra);
}

function cellAxisItem(columnName, columnType, aggregator, extra) {
  return Object.assign({
    axis: 'cells',
    columnName,
    columnType,
    aggregator,
    caption: `${aggregator} of ${columnName}`
  }, extra);
}

function withTotals(axisItem) {
  return Object.assign({}, axisItem, { includeTotals: true });
}

// An axis item that expands an array: the member expression path spells out the
// unnesting derivation(s), e.g. ['unnest()'] or ['unnest()', 'unnest()'].
function arrayAxisItem(axis, columnName, columnType, derivation, memberExpressionPath, extra) {
  return Object.assign({
    axis,
    columnName,
    columnType,
    derivation,
    memberExpressionPath,
    caption: `${columnName}.${derivation}`
  }, extra);
}

function filterAxisItem(columnName, columnType, memberExpressionPath, derivation, valueLiteral) {
  return Object.assign({
    axis: 'filters',
    columnName,
    columnType,
    memberExpressionPath,
    derivation,
    caption: columnName,
    filter: {
      filterType: 'in',
      values: {
        [valueLiteral]: { label: String(valueLiteral), literal: valueLiteral, enabled: true }
      }
    }
  });
}

// Reads of the generated SQL -------------------------------------------------

// Count the CTEs defined in a WITH clause. The generators write one
// `"name" AS (` block per CTE, commas separating them.
function countCtes(sql) {
  const withClauseMatch = /^WITH\s([\s\S]*)$/.exec(sql);
  if (!withClauseMatch) {
    return 0;
  }
  const withClause = withClauseMatch[1];
  const matches = withClause.match(/(?:^|\n)\s*,?\s*"?[\w.$]+"?\s+AS\s*\(/g);
  return matches ? matches.length : 0;
}

// Return the body of the CTE with the given alias.
function getCteBody(sql, cteName) {
  const marker = `"${cteName}" AS (`;
  let index = sql.indexOf(marker);
  let openIndex, bodyStart;
  if (index === -1) {
    index = sql.indexOf(`${cteName} AS (`);
    if (index === -1) {
      return undefined;
    }
  }
  openIndex = sql.indexOf('(', index);
  bodyStart = openIndex + 1;
  let depth = 1;
  for (let i = bodyStart; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') {
      depth += 1;
    }
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(bodyStart, i);
      }
    }
  }
  return undefined;
}

const SAMPLE_DATA_DUCKDB = [
  "CREATE TABLE sales AS SELECT * FROM (VALUES",
  "  ('r1', 'c1', ['a', 'b'], 10),",
  "  ('r1', 'c2', ['b'], 20),",
  "  ('r2', 'c1', ['c'], 30),",
  "  ('r2', 'c2', ['a', 'c'], 40)",
  ") AS t(region, category, tags, amount);",
  "CREATE TABLE matrix_sales AS SELECT * FROM (VALUES",
  "  ('r1', [[1, 2], [3]], 1),",
  "  ('r2', [[4]], 2)",
  ") AS t(region, matrix, amount);"
].join('\n');

module.exports = {
  DATASOURCE,
  SAMPLE_DATA_DUCKDB,
  rowAxisItem,
  columnAxisItem,
  cellAxisItem,
  withTotals,
  arrayAxisItem,
  filterAxisItem,
  countCtes,
  getCteBody
};
