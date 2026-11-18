// Shared stubs so the pivot-table SQL generator can run offline under Node.
global.window = { hueyDb: { reservedWords: [] } };
global.settings = {
  getSettings: () => ({
    alwaysQuoteIdentifiers: false,
    commaStyle: 'newlineBefore',
    keywordLetterCase: 'upperCase'
  })
};
global.Internationalization = { getText: (text) => text };
global.FilterDialog = {
  filterTypes: {
    INCLUDE: 'in', EXCLUDE: 'notin', LIKE: 'like', NOTLIKE: 'notlike',
    BETWEEN: 'between', NOTBETWEEN: 'notbetween',
    HASANY: 'hasany', HASALL: 'hasall', NOTHASANY: 'nothasany', NOTHASALL: 'nothasall'
  },
  isRangeFilterType: t => t === 'between' || t === 'notbetween',
  isExclusiveFilterType: t =>
    t === 'notin' || t === 'notlike' || t === 'notbetween' || t === 'nothasany' || t === 'nothasall'
};
global.QueryModel = { AXIS_FILTERS: 'filters', AXIS_ROWS: 'rows', AXIS_COLUMNS: 'columns', AXIS_CELLS: 'cells' };
global.TupleSet = { groupingIdAlias: '__huey_grouping_id' };
global.AttributeUi = {
  arrayDerivations: {
    'elements': {
      hasElementDataType: true,
      expressionTemplate: 'unnest( case len( coalesce( ${columnExpression}, []) ) when 0 then [ NULL ] else ${columnExpression} end )',
      unnestingFunction: 'unnest'
    },
    'element indices': {
      columnType: 'BIGINT',
      expressionTemplate: 'generate_subscripts( case len( coalesce( ${columnExpression}, []) ) when 0 then [ NULL ] else ${columnExpression} end, 1)',
      unnestingFunction: 'generate_subscripts'
    },
    'length': { expressionTemplate: 'length( ${columnExpression} )', columnType: 'BIGINT' }
  },
  mapDerivations: {},
  aggregators: {
    count: { expressionTemplate: 'COUNT( ${columnExpression} )', columnType: 'BIGINT' },
    sum: { expressionTemplate: 'SUM( ${columnExpression} )' }
  },
  getDerivationInfo(name) { return Object.assign({}, this.arrayDerivations, this.mapDerivations)[name]; },
  getAggregatorInfo(name) { return this.aggregators[name]; }
};
