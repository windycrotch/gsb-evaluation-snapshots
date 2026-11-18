class SqlQueryGenerator {

  static #getUnnestingFunctions(){
    const unnestingFunctions = {};
    Object.keys(AttributeUi.arrayDerivations).forEach(arrayDerivationKey => {
      const arrayDerivation = AttributeUi.arrayDerivations[arrayDerivationKey];
      const unnestingFunction = arrayDerivation.unnestingFunction;
      if (!unnestingFunction){
        return;
      }
      unnestingFunctions[unnestingFunction + '()'] = arrayDerivation;
    });
    return unnestingFunctions;
  }
  
  static #getExpressionString(columnName, memberExpressionPath){
    const columnExpression = quoteIdentifierWhenRequired(columnName);
    const pathExpression = memberExpressionPath.map(memberExpressionPathElement => {
      return `[${quoteStringLiteral( memberExpressionPathElement ) }]`
    }).join('');
    return `${columnExpression}${pathExpression}`;
  }

  static #getMemberExpressionPathStringForPathWithUnnestingOperation(filterAxisItem){
    const memberExpressionPath = filterAxisItem.memberExpressionPath;
    if (!memberExpressionPath || !memberExpressionPath.length){
      return undefined;
    }
    let memberExpressionPathString = undefined;
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    for (let j = 0; j < memberExpressionPath.length; j++) {
      const memberExpressionPathElement = memberExpressionPath[j];
      if (unnestingFunctions[memberExpressionPathElement] === undefined) {
        continue;
      }
      memberExpressionPathString = SqlQueryGenerator.#getExpressionString(
        filterAxisItem.columnName, 
        memberExpressionPath
      );
      break;
    }
    return memberExpressionPathString;
  }

  // TODO: we have to correctly stage and unwrap an axis aggregate filter items
  // By that I mean, unwrap the subject of the aggregate as well as its partition columns from any nesting (if applicable)
  // and carry axis aggregates on the unnested values all the way to the last stage.
  static #getFilterItemsByNestingStage(filterAxisItems){
    const filterAxisItemsByNestingStage = {};
    if (!filterAxisItems){
      return filterAxisItemsByNestingStage;
    }
    
    // only retain filter items that have values
    filterAxisItems = filterAxisItems.filter(filterAxisItem => {
      const filter = filterAxisItem.filter;
      if (!filter){
        return false;
      }
      
      const values = filter.values;
      if (!values){
        return false;
      }
      
      const keys = Object.keys(values).filter(key => {
        const valueObject = values[key];
        return valueObject.enabled !== false;
      });
      
      if (!keys.length){
        return false;
      }
      
      return true;
    });
    
    if (!filterAxisItems.length){
      return filterAxisItemsByNestingStage;
    }

    // analyze the filter items and store them in a dict:
    // - filter items that require unnesting are stored by memberExpressionPath
    // note that different filter items may share the same member expression path,
    // so each entry has to hold a list rather than a single item.
    const topLevelFilterAxisItems = [];
    for (let i = 0; i < filterAxisItems.length; i++){
      const filterAxisItem = filterAxisItems[i];
      const memberExpressionPathString = SqlQueryGenerator.#getMemberExpressionPathStringForPathWithUnnestingOperation(filterAxisItem);
      if (memberExpressionPathString) {
        let nestingStageFilterAxisItems = filterAxisItemsByNestingStage[memberExpressionPathString];
        if (nestingStageFilterAxisItems === undefined) {
          filterAxisItemsByNestingStage[memberExpressionPathString] = nestingStageFilterAxisItems = [];
        }
        nestingStageFilterAxisItems.push(filterAxisItem);
      }
      else {
        topLevelFilterAxisItems.push(filterAxisItem);
      }
    }
    
    // - filter items that do not require unnesting are stored separateley and finally stored by path ''
    if (topLevelFilterAxisItems.length){
      filterAxisItemsByNestingStage[''] = topLevelFilterAxisItems;
    }
    return filterAxisItemsByNestingStage;
  }
  
  static #getConditionForFilterItems(filterItems, tableAlias){
    // cull filter items that have incomplete filters
    // and filters without any enabled filter values.
    filterItems = filterItems.filter(filterItem => {
      return QueryAxisItem.isFilterItemEffective(filterItem);
    });
    
    // create SQL conditions for filter items
    const filterConditions = filterItems.map(filterItem => {
      let conditionSql;
      const queryAxisItems = filterItem.queryAxisItems;
      // this happens when the cellset generates a filter item to push down tuples, 
      // see https://github.com/rpbouman/huey/issues/134
      if (queryAxisItems) {
        const fields = filterItem.fields;
        const columns = queryAxisItems.map(queryAxisItem => {
          const columnSql = QueryAxisItem.getSqlForQueryAxisItem(queryAxisItem);
          return columnSql;
        }).join('\n, ');
        const values = filterItem.filter.values.map(tupleValues => {
          const valueList = queryAxisItems.map((queryAxisItem, index) => {
            const literalWriter = queryAxisItem.literalWriter;
            const value = tupleValues[index];
            const field = fields[index];
            return literalWriter(value, field);
          }).join(',');
          return `(${valueList})`;
        }).join('\n,');
        conditionSql = `(${columns}) IN (${values})`;
      }
      else {
        // this is the "normal", ui driven filter route.
        conditionSql = QueryAxisItem.getFilterConditionSql(filterItem, tableAlias);
      }
      return conditionSql;
    });
    
    // combine SQL conditions
    const filterCondition = filterConditions.join('\nAND ');
    
    // done.
    return filterCondition;
  }
  
  // test whether a filter item's member expression starts with the given
  // column + path prefix. Compared token by token so that prefixes never
  // accidentally match a longer, differently named column.
  static #memberExpressionPathStartsWith(columnName, memberExpressionPath, prefixColumnName, prefixMemberExpressionPath){
    if (columnName !== prefixColumnName) {
      return false;
    }
    if (prefixMemberExpressionPath.length > memberExpressionPath.length) {
      return false;
    }
    for (let i = 0; i < prefixMemberExpressionPath.length; i++) {
      if (memberExpressionPath[i] !== prefixMemberExpressionPath[i]) {
        return false;
      }
    }
    return true;
  }

  // find the unnesting function (if any) that occurs immediately after the given prefix
  static #getUnnestingFunctionNameAtPathPrefix(columnName, memberExpressionPath, prefixColumnName, prefixMemberExpressionPath){
    if (!SqlQueryGenerator.#memberExpressionPathStartsWith(columnName, memberExpressionPath, prefixColumnName, prefixMemberExpressionPath)) {
      return undefined;
    }
    const pathElement = memberExpressionPath[prefixMemberExpressionPath.length];
    if (pathElement === undefined) {
      return undefined;
    }
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    return unnestingFunctions[pathElement] === undefined ? undefined : pathElement;
  }

  // Express a reference (column name + member expression path) in terms of the
  // columns produced by an unnesting stage. When the reference points at an
  // array element that this stage expands, the returned reference uses the
  // unnested column name and keeps whatever path remains after that expansion.
  // Returns undefined when the reference is not affected by this stage.
  static #rewriteReferenceForUnnestingStage(
    columnName,
    memberExpressionPath,
    stageColumnName,
    stageMemberExpressionPath,
    stageUnnestingFunctions
  ){
    memberExpressionPath = memberExpressionPath || [];
    if (columnName !== stageColumnName) {
      return undefined;
    }
    if (memberExpressionPath.length <= stageMemberExpressionPath.length) {
      return undefined;
    }
    for (let i = 0; i < stageMemberExpressionPath.length; i++) {
      if (memberExpressionPath[i] !== stageMemberExpressionPath[i]) {
        return undefined;
      }
    }
    const unnestingFunctionName = memberExpressionPath[stageMemberExpressionPath.length];
    if (stageUnnestingFunctions[unnestingFunctionName] === undefined) {
      return undefined;
    }
    const remainingMemberExpressionPath = memberExpressionPath.slice(stageMemberExpressionPath.length + 1);
    return {
      columnName: [stageColumnName].concat(stageMemberExpressionPath, [unnestingFunctionName]).join('.'),
      memberExpressionPath: remainingMemberExpressionPath.length ? remainingMemberExpressionPath : undefined
    };
  }

  // Rewrite the subject and partitionByItems of an axis aggregate so they
  // reference the columns produced by the current unnesting stage. A window
  // function cannot contain unnest(), so every array element the aggregate is
  // computed over has to be referenced by its unnested column. Returns true
  // when at least one reference was rewritten.
  static #rewriteAxisAggregateForUnnestingStage(
    item,
    stageColumnName,
    stageMemberExpressionPath,
    stageUnnestingFunctions
  ){
    let rewritten = false;

    const subjectRewrite = SqlQueryGenerator.#rewriteReferenceForUnnestingStage(
      item.columnName,
      item.memberExpressionPath,
      stageColumnName,
      stageMemberExpressionPath,
      stageUnnestingFunctions
    );
    if (subjectRewrite) {
      rewritten = true;
      item.columnName = subjectRewrite.columnName;
      if (subjectRewrite.memberExpressionPath) {
        item.memberExpressionPath = subjectRewrite.memberExpressionPath;
      }
      else {
        delete item.memberExpressionPath;
      }
      if (item.derivation && !item.memberExpressionPath) {
        const derivationInfo = AttributeUi.getDerivationInfo(item.derivation);
        if (derivationInfo && derivationInfo.unnestingFunction) {
          delete item.derivation;
        }
      }
    }

    const partitionByItems = item.partitionByItems;
    if (partitionByItems && partitionByItems.length) {
      item.partitionByItems = partitionByItems.map(partitionByItem => {
        const partitionRewrite = SqlQueryGenerator.#rewriteReferenceForUnnestingStage(
          partitionByItem.columnName,
          partitionByItem.memberExpressionPath,
          stageColumnName,
          stageMemberExpressionPath,
          stageUnnestingFunctions
        );
        if (!partitionRewrite) {
          return partitionByItem;
        }
        rewritten = true;
        const newPartitionByItem = Object.assign({}, partitionByItem, {
          columnName: partitionRewrite.columnName
        });
        if (partitionRewrite.memberExpressionPath) {
          newPartitionByItem.memberExpressionPath = partitionRewrite.memberExpressionPath;
        }
        else {
          delete newPartitionByItem.memberExpressionPath;
          delete newPartitionByItem.derivation;
        }
        return newPartitionByItem;
      });
    }

    return rewritten;
  }

  // Determine whether this stage has to expand an array that the given axis
  // aggregate is based on - either as the subject of the aggregate or as one
  // of its partition columns. If so, the aggregate cannot be evaluated here:
  // a window function cannot contain unnest(), so it has to run after the
  // expansion. Returns true when that is the case.
  static #axisAggregateRequiresUnnestingAtStage(item, stageColumnName, stageMemberExpressionPath, stageUnnestingFunctions){
    const matchesStage = (columnName, memberExpressionPath) => {
      return SqlQueryGenerator.#rewriteReferenceForUnnestingStage(
        columnName,
        memberExpressionPath,
        stageColumnName,
        stageMemberExpressionPath,
        stageUnnestingFunctions
      ) !== undefined;
    };

    if (matchesStage(item.columnName, item.memberExpressionPath)) {
      return true;
    }
    const partitionByItems = item.partitionByItems;
    if (!partitionByItems || !partitionByItems.length) {
      return false;
    }
    return partitionByItems.some(partitionByItem => {
      return matchesStage(partitionByItem.columnName, partitionByItem.memberExpressionPath);
    });
  }

  // Replace a deferred axis aggregate in the current stage's select list with
  // plain projections of the columns it needs, so a later stage can compute the
  // window function from the expanded values.
  static #projectAxisAggregateBaseColumns(cte, item){
    const existingColumnNames = new Set(
      cte.items
      .filter(stageItem => !stageItem.isUnnestingExpression)
      .map(stageItem => stageItem.columnName)
    );

    const baseColumns = [];
    const addBaseColumn = (columnName, columnType, memberExpressionPath) => {
      if (!columnName || columnName === '*' || existingColumnNames.has(columnName)) {
        return;
      }
      // a reference that still has a path will be produced by an unnesting
      // operation, not by a plain projection
      if (memberExpressionPath && memberExpressionPath.length) {
        return;
      }
      baseColumns.push({
        columnName: columnName,
        columnType: columnType
      });
      existingColumnNames.add(columnName);
    };

    addBaseColumn(item.columnName, item.columnType, item.memberExpressionPath);
    (item.partitionByItems || []).forEach(partitionByItem => {
      addBaseColumn(partitionByItem.columnName, partitionByItem.columnType, partitionByItem.memberExpressionPath);
    });
    return baseColumns;
  }

  static #transformFilterItems(
    filterAxisItemsByNestingStage,
    unnestingOperationItem
  ){
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    const filters = [];

    const prefixColumnName = unnestingOperationItem.columnName;
    const prefixMemberExpressionPath = unnestingOperationItem.memberExpressionPath;

    // check each filter path to see if it matches this unnesting stage
    const filterPaths = Object.keys(filterAxisItemsByNestingStage);
    for (let i = 0; i < filterPaths.length; i++){
      const filterPath = filterPaths[i];
      const stageFilterAxisItems = filterAxisItemsByNestingStage[filterPath];
      if (!stageFilterAxisItems) {
        continue;
      }
      const retainedFilterAxisItems = [];
      for (let k = 0; k < stageFilterAxisItems.length; k++){
        const originalFilterAxisItem = stageFilterAxisItems[k];
        const originalMemberExpressionPath = originalFilterAxisItem.memberExpressionPath || [];

        // find an unnesting function in the filter immediately after this stage's prefix
        const unnestingFunctionName = SqlQueryGenerator.#getUnnestingFunctionNameAtPathPrefix(
          originalFilterAxisItem.columnName,
          originalMemberExpressionPath,
          prefixColumnName,
          prefixMemberExpressionPath
        );

        if (!unnestingFunctionName) {
          // filter path does not match this unnesting stage - leave it for a later stage
          retainedFilterAxisItems.push(originalFilterAxisItem);
          continue;
        }

        // this filter path matches this unnesting stage, so register that in the unnesting operation
        if (unnestingOperationItem.unnestingFunctions[unnestingFunctionName] === undefined){
          unnestingOperationItem.unnestingFunctions[unnestingFunctionName] = 0;
        }
        unnestingOperationItem.unnestingFunctions[unnestingFunctionName] += 1;

        // since these filter items are part of this unnesting stage,
        // we need replace them with new filter items that reference the column of the unnested item
        const substituteMemberExpressionPath = originalMemberExpressionPath.slice(prefixMemberExpressionPath.length + 1);
        const columnExpression = [unnestingOperationItem.columnName].concat(unnestingOperationItem.memberExpressionPath);
        columnExpression.push(unnestingFunctionName);

        // we also need to substittue the column data type to reflect the column change.
        let substituteColumnType;
        const unnestingFunction = unnestingFunctions[unnestingFunctionName];
        if (unnestingFunction.columnType){
          substituteColumnType = unnestingFunction.columnType;
        }
        else
        if (unnestingFunction.hasElementDataType){
          substituteColumnType = getMemberExpressionType(originalFilterAxisItem.columnType, unnestingOperationItem.memberExpressionPath);
          substituteColumnType = getArrayElementType(substituteColumnType);
        }

        const filterAxisItem = Object.assign({}, originalFilterAxisItem, {
          columnName: columnExpression.join('.'),
          columnType: substituteColumnType
        });


        if (substituteMemberExpressionPath.length){
          filterAxisItem.memberExpressionPath = substituteMemberExpressionPath;
        }
        else {
          delete filterAxisItem.memberExpressionPath;
          if (filterAxisItem.derivation) {
            const derivationInfo = AttributeUi.getDerivationInfo(filterAxisItem.derivation);
            if (derivationInfo.unnestingFunction) {
              delete filterAxisItem.derivation;
            }
          }
        }

        // now we have to check whether the remaining expressionpath of the filter item still contains unnesting expressions.
        // if it does, then we have to register the substituted item under its new path so a later stage picks it up
        // if it does not, then we have to remove the path and the item from filterAxisItemsByNestingStage and add them to the cte
        const memberExpressionPathString = SqlQueryGenerator.#getMemberExpressionPathStringForPathWithUnnestingOperation(filterAxisItem);
        if (memberExpressionPathString) {
          // register the substituted item under the new path (its column name changed)
          if (memberExpressionPathString === filterPath) {
            retainedFilterAxisItems.push(filterAxisItem);
          }
          else {
            let nestedStageFilterAxisItems = filterAxisItemsByNestingStage[memberExpressionPathString];
            if (nestedStageFilterAxisItems === undefined) {
              filterAxisItemsByNestingStage[memberExpressionPathString] = nestedStageFilterAxisItems = [];
            }
            nestedStageFilterAxisItems.push(filterAxisItem);
          }
        }
        else {
          // no more unnesting operations for this filter item past this stage, so we have to apply it here.
          filters.push(filterAxisItem);
        }
      }
      if (retainedFilterAxisItems.length) {
        filterAxisItemsByNestingStage[filterPath] = retainedFilterAxisItems;
      }
      else {
        delete filterAxisItemsByNestingStage[filterPath];
      }
    }
    return filters.length ? filters : undefined;
  }

  // When no axis item requires unnesting but a filter does, we still need an
  // unnesting stage: the filter targets an array element and has to be evaluated
  // against the unnested values rather than at the outermost level.
  static #createFilterOnlyUnnestingStage(cte, filterAxisItemsByNestingStage){
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    const filterPaths = Object.keys(filterAxisItemsByNestingStage);

    let match;
    for (let i = 0; i < filterPaths.length; i++){
      const filterPath = filterPaths[i];
      const stageFilterAxisItems = filterAxisItemsByNestingStage[filterPath];
      if (!stageFilterAxisItems) {
        continue;
      }
      for (let k = 0; k < stageFilterAxisItems.length; k++){
        const filterAxisItem = stageFilterAxisItems[k];
        const memberExpressionPath = filterAxisItem.memberExpressionPath;
        if (!memberExpressionPath || !memberExpressionPath.length) {
          continue;
        }
        const index = memberExpressionPath.findIndex(element => unnestingFunctions[element] !== undefined);
        if (index === -1) {
          continue;
        }
        // prefer the shallowest unnesting operation so outer levels are expanded first
        if (!match || index < match.index) {
          match = { filterAxisItem, index, filterPath };
        }
      }
    }
    if (!match) {
      return undefined;
    }

    const filterAxisItem = match.filterAxisItem;
    const unnestingFunctionName = filterAxisItem.memberExpressionPath[match.index];
    const unnestingFunction = unnestingFunctions[unnestingFunctionName];
    const memberExpressionPathPrefix = filterAxisItem.memberExpressionPath.slice(0, match.index);

    let elementType;
    if (unnestingFunction.columnType) {
      elementType = unnestingFunction.columnType;
    }
    else {
      elementType = getArrayElementType(
        getMemberExpressionType(filterAxisItem.columnType, memberExpressionPathPrefix)
      );
    }

    const unnestingOperationItem = {
      isUnnestingExpression: true,
      columnName: filterAxisItem.columnName,
      columnType: filterAxisItem.columnType,
      elementType: elementType,
      memberExpressionPath: memberExpressionPathPrefix,
      unnestingFunctions: {}
    };

    const filters = SqlQueryGenerator.#transformFilterItems(
      filterAxisItemsByNestingStage,
      unnestingOperationItem
    );

    cte.items.push(unnestingOperationItem);

    return {
      unnestingOperationItem: unnestingOperationItem,
      filters: filters
    };
  }
  
  static #getUnnestingStages(datasource, queryAxisItems, filterAxisItemsByNestingStage){
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    let alias = '__huey_data_foundation';
    const fromClause = datasource.getFromClauseSql();
    const filterAxisItems = filterAxisItemsByNestingStage[''];
    delete filterAxisItemsByNestingStage[''];
    const currentItems = queryAxisItems;
    let cte = {
      items: currentItems,
      from: `${fromClause} AS "${alias}"`,
      filters: filterAxisItems,
      alias: alias
    };
    const ctes = [cte];
    const findIndexOfRowNumberItem = function(queryAxisItem){
      return queryAxisItem.derivation === 'row number';
    };
    let indexOfRownumberItem = currentItems.findIndex(findIndexOfRowNumberItem);
    
    let newItems;
    if (indexOfRownumberItem !== -1){
      newItems = Object.assign([], currentItems);
      do {
        const rowNumberItem = newItems[indexOfRownumberItem];
        const newRowNumberItem = Object.assign({}, rowNumberItem);
        newRowNumberItem.columnName = QueryAxisItem.getSqlForQueryAxisItem(rowNumberItem);
        delete newRowNumberItem.derivation;
        newItems[indexOfRownumberItem] = newRowNumberItem;
        indexOfRownumberItem = newItems.findIndex(findIndexOfRowNumberItem);
      } while (indexOfRownumberItem !== -1);
      alias = 'cte' + (ctes.length + 1);
      ctes.push({
        items: newItems,
        alias: alias,
        from: `FROM ${cte.alias} AS "${alias}"`
      });
    }
    
    // go over ctes to detect unnesting operations
    // add new cte for each new level of unnesting operation
    
   let unnestingItem;
   let filterOnlyStage;
   do {
      unnestingItem = undefined;
      filterOnlyStage = undefined;
      cte = ctes[ctes.length - 1];
      // at the start of a new stage, initialize
      let unnestingDerivation = undefined;
      let unnestingOperationItem = undefined;
      let memberPathExpressionElement;
      let unnestingItemMemberExpressionPathIndex = undefined;
      let unnestingItemMemberExpressionPathPrefix = undefined;
      let unnestingItemMemberExpressionPathPrefixString = undefined;
      let unnestingItemMemberExpression = undefined;
      let unnestingItemMemberExpressionType = undefined;
      newItems = [];
      let filters;
      const cteItems = cte.items;
      cte.items = [];
      // go over the items currently in scope
      for (let i = 0; i < cteItems.length; i++){

        const currentItem = cteItems[i];
        const derivationInfo = currentItem.derivation ? AttributeUi.getDerivationInfo(currentItem.derivation) : undefined;
        const currentItemMemberExpressionPath = currentItem.memberExpressionPath;
    
        // if there's no member expression path, this is a "normal" item (and certainly not an unnesting operation)
        if (!currentItemMemberExpressionPath) {
          cte.items.push(currentItem);
          newItems.push(currentItem);
          continue;
        }
        
        if (!unnestingItem) {
          // if we haven't found an unnesting operation yet, we go looking for
          // by examining each part of the member expression path.
          for (let j = 0; j < currentItemMemberExpressionPath.length; j++) {
            memberPathExpressionElement = currentItemMemberExpressionPath[j];
            unnestingDerivation = unnestingFunctions[memberPathExpressionElement];
            if (unnestingDerivation === undefined) {
              continue;
            }
            
            // we found an unnesting operation!
            unnestingItem = currentItem;
            unnestingItemMemberExpressionPathIndex = j;
            unnestingItemMemberExpressionPathPrefix = currentItemMemberExpressionPath.slice(0, j);

            unnestingItemMemberExpressionPathPrefixString = SqlQueryGenerator.#getExpressionString(
              unnestingItem.columnName, 
              unnestingItemMemberExpressionPathPrefix
            );
            
            // get the type of the array we're unnesting
            unnestingItemMemberExpressionType = getMemberExpressionType(
              currentItem.columnType, 
              unnestingItemMemberExpressionPathPrefix
            );
            // to get the element type, remove the trailing []
            if (derivationInfo && (derivationInfo.hasKeyDataType || derivationInfo.hasValueDataType)) {
            }
            else {
              unnestingItemMemberExpressionType = getArrayElementType(unnestingItemMemberExpressionType);
            }
            
            // add an unnesting operation to the current cte.
            unnestingOperationItem = {
              isUnnestingExpression: true,
              columnName: currentItem.columnName,
              columnType: currentItem.columnType,
              elementType: unnestingItemMemberExpressionType,
              memberExpressionPath: unnestingItemMemberExpressionPathPrefix,
              // we use this to record which unnesting functions should be called at this level.
              // currently it could be either unnest(), generate_subscrips(), or both
              // at the bottem part of the outer loop, when creating items for the next cte, 
              // we count how many times there are items based on either of these functions.
              // Then, when generating SQL we figure if we have have to generate SQL expressions
              // for either or both these functions
              unnestingFunctions: {}
            };
            
            // check if there are any filter items at this unnesting level.
            filters = SqlQueryGenerator.#transformFilterItems(
              filterAxisItemsByNestingStage,
              unnestingOperationItem
            );

            cte.items.push(unnestingOperationItem);
            break;
          }
        }

        // if there is no unnesting item, 
        // or if the current item is not part of the unnesting stage, 
        // then carry the current item and continue with the next
        if (
          !unnestingItem ||
          unnestingItemMemberExpressionPathPrefixString !== SqlQueryGenerator.#getExpressionString(
            currentItem.columnName, 
            currentItemMemberExpressionPath.slice(0, unnestingItemMemberExpressionPathIndex)
          )
        ){
          cte.items.push(currentItem);
          newItems.push(currentItem);
          continue;
        }
        
        // if we arrive here, it means the current item belongs to the current unnesting stage.
        // we already added the unnesting operation to the current cte
        // so where we add the rewritten version of the item as items for the next cte.
        
        const unnestingItemMemberExpressionPathPostfix = currentItemMemberExpressionPath.slice(unnestingItemMemberExpressionPathIndex + 1);
        memberPathExpressionElement = currentItemMemberExpressionPath[unnestingItemMemberExpressionPathIndex];
        
        if (unnestingOperationItem.unnestingFunctions[memberPathExpressionElement] === undefined){
          unnestingOperationItem.unnestingFunctions[memberPathExpressionElement] = 0;
        }
        unnestingOperationItem.unnestingFunctions[memberPathExpressionElement] += 1;
        unnestingDerivation = unnestingFunctions[memberPathExpressionElement];
        
        const newColumn = [].concat(unnestingItemMemberExpressionPathPrefix);
        newColumn.unshift(unnestingItem.columnName);
        newColumn.push(memberPathExpressionElement);
        const newItem = Object.assign({}, currentItem, {
          columnName: newColumn.join('.'),
          columnType: unnestingDerivation.columnType || unnestingOperationItem.elementType,
          memberExpressionPath: unnestingItemMemberExpressionPathPostfix
        });
        
        if (!unnestingItemMemberExpressionPathPostfix.length) {
          // if the unnesting operation is the terminal operation in the memberExpressionPath,
          // then the new item should be made terminal as well.
          // the unnesting operation itself is a derivation, and since that was unnested in the previous cte,
          // it must not be unnested again at a later level, so we remove that info here.
          if (newItem.derivation) {
            const newItemDerivationInfo = AttributeUi.getDerivationInfo(newItem.derivation);
            if (newItemDerivationInfo.unnestingFunction) {
              delete newItem.derivation;
            }
          }
          delete newItem.memberExpressionPath;
        }
        newItems.push(newItem);
        
      } // end items loop

      // Axis aggregates (window functions) evaluate their PARTITION BY at this
      // stage. If a partition item points at the array we just unnested, the
      // aggregate cannot be computed here: its window function would have to
      // contain unnest(). In that case we project the columns it is based on
      // in this stage and defer the aggregate to the next stage, where the
      // unnested column is available.
      if (unnestingOperationItem) {
        const deferredAxisAggregates = [];
        const stageItems = [];
        for (let i = 0; i < cte.items.length; i++) {
          const item = cte.items[i];
          if (
            QueryAxisItem.isAxisAggregate(item) &&
            SqlQueryGenerator.#axisAggregateRequiresUnnestingAtStage(
              item,
              unnestingOperationItem.columnName,
              unnestingOperationItem.memberExpressionPath,
              unnestingOperationItem.unnestingFunctions
            )
          ) {
            deferredAxisAggregates.push(item);
            continue;
          }
          stageItems.push(item);
        }
        cte.items = stageItems;
        deferredAxisAggregates.forEach(item => {
          // make sure the columns feeding the aggregate survive this stage
          SqlQueryGenerator.#projectAxisAggregateBaseColumns(cte, item).forEach(baseColumn => {
            cte.items.push(baseColumn);
          });
          if (newItems.indexOf(item) === -1) {
            newItems.push(item);
          }
        });
      }

      // Once the aggregate is deferred, rewrite its partition items so they
      // reference the column produced by this stage rather than the array
      // expression that was just expanded.
      if (unnestingOperationItem) {
        newItems = newItems.map(item => {
          if (!QueryAxisItem.isAxisAggregate(item)) {
            return item;
          }
          const newItem = Object.assign({}, item);
          const rewritten = SqlQueryGenerator.#rewriteAxisAggregateForUnnestingStage(
            newItem,
            unnestingOperationItem.columnName,
            unnestingOperationItem.memberExpressionPath,
            unnestingOperationItem.unnestingFunctions
          );
          return rewritten ? newItem : item;
        });
      }

      // If no axis item required unnesting at this stage, filters may still
      // target an array element path. In that case we introduce a stage anyway
      // so the filter can be pushed down to the level it belongs to.
      if (!unnestingItem) {
        filterOnlyStage = SqlQueryGenerator.#createFilterOnlyUnnestingStage(
          cte,
          filterAxisItemsByNestingStage
        );
        if (filterOnlyStage) {
          filters = filterOnlyStage.filters;
        }
      }

      if (unnestingItem || filterOnlyStage) {
        alias = 'cte' + (ctes.length + 1);
        ctes.push({
          items: newItems,
          alias: alias,
          from: `FROM ${cte.alias} AS "${alias}"`,
          filters: filters
        });
      }
      // if we didn't find a new unnesting stage, we are done.
    } while(unnestingItem || filterOnlyStage);
    return ctes;
  }

  static #getSqlSelectStatementForFinalStage(cte, options){
    const queryAxisItems = options.queryAxisItems; 
    const includeCountAll = options.includeCountAll;
    let countAllAlias = options.countAllAlias;
    const nullsSortOrder = options.nullsSortOrder;
    const totalsPosition = options.totalsPosition;
    const includeOrderBy = options.includeOrderBy === false ? false : true;
    const useLateralColumnAlias = options.useLateralColumnAlias === false ? false : true;
    const columnExpressions = {};
    cte.items.forEach((item, index) => {
      const originalItem = queryAxisItems[index];
      const caption = QueryAxisItem.getCaptionForQueryAxisItem(originalItem);
      const selectListExpression = QueryAxisItem.getSqlForQueryAxisItem(item, cte.alias);
      columnExpressions[caption] = selectListExpression;
    });
    
    const selectListExpressions = [];

    // the group by expression includes expressons for all axis items.
    let axisGroupByExpressions;
    
    const groupByExpressions = {};
    groupByExpressions[QueryModel.AXIS_ROWS] = [];
    groupByExpressions[QueryModel.AXIS_COLUMNS] = [];
    
    // the groupingSets are created when we find an axis item that has includeTotals
    let axisGroupingSets;
    
    const groupingSets = {};
    groupingSets[QueryModel.AXIS_ROWS] = [];
    groupingSets[QueryModel.AXIS_COLUMNS] = [];
    
    const groupingIdExpressions = [];
    const orderByExpressions = [];
    
    const columnIds = Object.keys(columnExpressions);
    for (let i = 0; i < columnIds.length; i++) {
      const columnId = columnIds[i];
      const columnExpression = columnExpressions[columnId];
      const columnAlias = quoteIdentifierWhenRequired(columnId);
      
      if (includeCountAll && i >= queryAxisItems.length) {
        // when includeCountAll is true, we generate one extra count() over () expression
        // we need that count all to figure out how many tuples there are on the axis in total
        selectListExpressions.push(columnExpression);
        // since this does not correspond to an actual query item, we whould leave immediately after
        break;
      }
      
      selectListExpressions.push(`${columnExpression} AS ${columnAlias}`);

      const columnExpressionReference = useLateralColumnAlias ? columnAlias : columnExpression;

      const queryAxisItem = queryAxisItems[i];
      const axisId = queryAxisItem.axis;
      if (axisId === QueryModel.AXIS_CELLS){
        continue;
      }
      
      const sortDirection = queryAxisItem.sortDirection || 'ASC';
      let itemNullsSortOrder = queryAxisItem.nullsSortOrder || nullsSortOrder
      itemNullsSortOrder = itemNullsSortOrder ? ` NULLS ${itemNullsSortOrder}` : '';
      
      axisGroupByExpressions = groupByExpressions[axisId];
      
      if (queryAxisItem.includeTotals){
        // make a grouping set for the GROUP BY expression up to this point
        const groupingSet = [].concat(axisGroupByExpressions);
        axisGroupingSets = groupingSets[axisId];
        axisGroupingSets.push(groupingSet);
        
        // each totals column needs to be included in a grouping id expression
        // so we can figure out which result rows are totals (and for what group).
        
        // adding columnExpression rather than reference, see https://github.com/rpbouman/huey/issues/401 
        groupingIdExpressions.push(columnExpression);
        //groupingIdExpressions.push(columnExpressionReference);
        
        // store a placeholder for the groupingId expression in the order by expressions.
        // we will replace these later with expressions to sort the totals.
        orderByExpressions.push(columnExpression);
      }
      
      // adding columnExpression rather than reference, see https://github.com/rpbouman/huey/issues/401 
      // axisGroupByExpressions.push(columnExpression);
      axisGroupByExpressions.push(columnExpressionReference);
      
      let orderByExpression = `${columnExpressionReference} ${sortDirection}`;
      orderByExpression += itemNullsSortOrder;
      orderByExpressions.push(orderByExpression);
    }

    if (includeCountAll) {
      const countExpression = 'COUNT(*) OVER ()';
      countAllAlias = countAllAlias || countExpression;
      selectListExpressions.push(`${countExpression} AS "${countAllAlias}"`);
    }
    
    let groupByClause = undefined;
    if (groupingSets[QueryModel.AXIS_ROWS].length || groupingSets[QueryModel.AXIS_COLUMNS].length){
      axisGroupingSets = [];

      const rowsAxisGroupingSets = groupingSets[QueryModel.AXIS_ROWS];
      axisGroupByExpressions = groupByExpressions[QueryModel.AXIS_ROWS];
      if (rowsAxisGroupingSets.length) {
        if (rowsAxisGroupingSets[rowsAxisGroupingSets.length - 1].length < axisGroupByExpressions.length){
          // if we have to make grouping sets, then we need to add our "normal" group by clause too
          rowsAxisGroupingSets.push([].concat(axisGroupByExpressions));
        }
      }
      else
      if (axisGroupByExpressions.length) {
        rowsAxisGroupingSets.push(axisGroupByExpressions);
      }

      const columnsAxisGroupingSets = groupingSets[QueryModel.AXIS_COLUMNS];
      axisGroupByExpressions = groupByExpressions[QueryModel.AXIS_COLUMNS];
      if (columnsAxisGroupingSets.length){
        if (columnsAxisGroupingSets[columnsAxisGroupingSets.length - 1].length < axisGroupByExpressions.length){
          // if we have to make grouping sets, then we need to add our "normal" group by clause too
          columnsAxisGroupingSets.push([].concat(axisGroupByExpressions));
        }
      }
      else
      if (axisGroupByExpressions.length) {
        columnsAxisGroupingSets.push(axisGroupByExpressions);
      }

      if (rowsAxisGroupingSets.length && columnsAxisGroupingSets.length) {
        axisGroupingSets = [];
        rowsAxisGroupingSets.forEach(rowsAxisGroupingSet => {
          columnsAxisGroupingSets.forEach((columnsAxisGroupingSet) => {
            axisGroupingSets.push([].concat(rowsAxisGroupingSet, columnsAxisGroupingSet));
          });
        });
      }
      else 
      if (rowsAxisGroupingSets.length){
        axisGroupingSets = rowsAxisGroupingSets;
      }
      else
      if (columnsAxisGroupingSets.length){
        axisGroupingSets = columnsAxisGroupingSets;
      }
      
      const groupingSetsSql = axisGroupingSets
      .map(groupingSet => {                     // generate SQL for grouping set
        return [
          '  (',
          `    ${groupingSet.join('\n  , ')}`,
          '  )'
        ].join('\n');
      })
      .join(',');
      groupByClause = `GROUPING SETS(\n${groupingSetsSql}\n)`;

      // if we have grouping sets, we need to add a GROUPING_ID expression 
      // over all grouping exprssions so we can identify which rows are super-aggregate rows
      const groupingIdAlias = quoteIdentifierWhenRequired(TupleSet.groupingIdAlias);
      const groupingIdExpression = `\n GROUPING_ID(\n   ${groupingIdExpressions.join('\n , ')}\n  ) AS ${groupingIdAlias}`;
      selectListExpressions.unshift(groupingIdExpression);

      // for each column in the grouping id, 
      // insert an order by expression to keep the totals together with the items they are totalling
      let sortDir = totalsPosition === 'AFTER' ? 'ASC' : 'DESC';
      groupingIdExpressions.forEach((groupingIdExpression, groupingIdExpressionIndex) => {
        let bitshift = groupingIdExpressions.length - groupingIdExpressionIndex - 1;
        bitshift = bitshift ? `(1 << ${bitshift})` : 1;
        const orderByExpression = `${groupingIdAlias} & ${bitshift} ${sortDir}`;
        const indexOfGroupingIdExpression = orderByExpressions.indexOf(groupingIdExpression);
        orderByExpressions[indexOfGroupingIdExpression] = `${orderByExpression}`;
      });
    }
    else
    if (groupByExpressions[QueryModel.AXIS_ROWS].length || groupByExpressions[QueryModel.AXIS_COLUMNS].length) {
      groupByClause = [].concat(
        groupByExpressions[QueryModel.AXIS_ROWS], 
        groupByExpressions[QueryModel.AXIS_COLUMNS]
      ).join('\n,');
    }

    let sql = [
      `SELECT ${selectListExpressions.join('\n,')}`,
      cte.from
    ];
    SqlQueryGenerator.#generateSqlClausesForFilterItems(cte, sql);

    if (groupByClause) {

      groupByClause = `GROUP BY ${groupByClause}`;
      sql.push(groupByClause);
    }
        
    if (includeOrderBy !== false && orderByExpressions.length) {
      sql.push(`ORDER BY ${orderByExpressions.join('\n,')}`);
    }

    sql = sql.join('\n');
    return sql;
  }

  static #getSqlSelectItemExpressionForIntermediateStage(cte, item, sqlOptions){
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    const selectListExpressions = {};
    let alias, expression;
    
    if (item.isUnnestingExpression === true) {
      const itemUnnestingFunctions = item.unnestingFunctions;
      Object.keys( itemUnnestingFunctions )
      .forEach( unnestingFunction => {
        const arrayDerivation = unnestingFunctions[unnestingFunction];
        const expressionTemplate = arrayDerivation.expressionTemplate;
        const columnExpression = QueryAxisItem.getSqlForColumnExpression(item, cte.alias, sqlOptions);
        expression = extrapolateColumnExpression(expressionTemplate, columnExpression);
        alias = [item.columnName].concat(item.memberExpressionPath, [unnestingFunction]).join('.');
        selectListExpressions[alias] = expression;
      } );
    }
    else 
    if (item.derivation === 'row number') {                         // special case, the built-in row number
      expression = QueryAxisItem.getSqlForQueryAxisItem(item);
      alias = expression;
      selectListExpressions[alias] = expression;
    }
    else 
    if ( QueryAxisItem.isAxisAggregate( item ) ){
      alias = QueryAxisItem.getCaptionForQueryAxisItem( item );
      expression = QueryAxisItem.getSqlForQueryAxisItem( item, cte.alias );
      selectListExpressions[alias] = expression;
    }
    else
    if (item.aggregator === 'count' && item.columnName === '*' ){   // special case, the built-in aggregate
      return;
    }
    else {
      alias = item.alias || item.columnName;
      expression = getQualifiedIdentifier(cte.alias, item.columnName);
      if (selectListExpressions[alias] === undefined) {
        selectListExpressions[alias] = expression;
      }
    }
    
    return {
      selectListExpressions: selectListExpressions,
      alias: alias, 
      expression: expression
    };
  }

  static #getSqlSelectStatementForIntermediateStage(cte, sqlOptions){
    const unnestingFunctions = SqlQueryGenerator.#getUnnestingFunctions();
    const selectListExpressions = {};
    cte.items.forEach(item => {
      const result = SqlQueryGenerator.#getSqlSelectItemExpressionForIntermediateStage(cte, item, sqlOptions);
      if (result){
        Object.assign(selectListExpressions, result.selectListExpressions);
      }
    });
    const sqlSelectList = Object.keys(selectListExpressions).map(columnId => {
      return `${selectListExpressions[columnId]} AS ${quoteIdentifierWhenRequired(columnId)}`
    });
    const sql = [
      `SELECT ${sqlSelectList.join('\n,')}`,
      cte.from
    ];
    
    SqlQueryGenerator.#generateSqlClausesForFilterItems(cte, sql);
    
    const samplingConfig = sqlOptions.samplingConfig;
    if (samplingConfig){
      sql.push( getUsingSampleClause(samplingConfig, true) );
    }

    sql.unshift(`"${cte.alias}" AS (`)
    sql.push(')');
    const sqlText = sql.join('\n');
    return sqlText;
  }

  static #generateSqlClausesForFilterItems(cte, sql){
    const filterAxisItems = cte.filters;
    if (!filterAxisItems || !filterAxisItems.length){
      return;
    }
    const whereClauseItems = [];
    const qualifyClauseItems = [];
    filterAxisItems.forEach( filterAxisItem => ( QueryAxisItem.isAxisAggregate(filterAxisItem) ? qualifyClauseItems : whereClauseItems ).push(filterAxisItem) );
    if (whereClauseItems.length) {
      const whereCondition = SqlQueryGenerator.#getConditionForFilterItems(whereClauseItems, cte.alias);
      sql.push(`WHERE ${whereCondition}`);
    }
    if (qualifyClauseItems.length) {
      const qualifyCondition = SqlQueryGenerator.#getConditionForFilterItems(qualifyClauseItems, cte.alias);
      sql.push(`QUALIFY ${qualifyCondition}`);
    }
  }
  
  static #createAxisAggregateStage(ctes){
    // the original query with the axis aggregages is the current last stage.
    // this can mostly stay in place, we just need to generate a stage on top to which the GROUP BY is applied.
    // this new stage is simply a projection on the stage with the axis aggregates
    const cte = ctes[ctes.length - 1];
    const oldItems = cte.items;
    const newItems = oldItems.map( item => { 
      const result = SqlQueryGenerator.#getSqlSelectItemExpressionForIntermediateStage(cte, item);
      if (!result) {
        return item;
      }
      const newItem = Object.assign( {}, item );
      if ( QueryAxisItem.isAxisAggregate(item) ){
        newItem.columnName = QueryAxisItem.getCaptionForQueryAxisItem( item )
        delete newItem['aggregator'];
      }
      return newItem;
    });
    const axisAggregateCte = {
      items: newItems,
      from: `FROM ${cte.alias}`,
    };
    ctes.push(axisAggregateCte);
  }

  static getSqlSelectStatementForAxisItems(options){
    const queryAxisItems = options.queryAxisItems;

    if (!queryAxisItems.length) {
      return undefined;
    }

    // analyze the items to see what axes they are on.
    // we need to know to correctly evaluate aggregate axis filter items
    const itemAxes = {};
    queryAxisItems.forEach( queryAxisItemm => {
      const axisId = queryAxisItemm.axis;
      if ( itemAxes[ axisId ] === undefined ) {
        itemAxes[ axisId ] = [];
      }
      itemAxes[ axisId ].push( queryAxisItemm );
    });
    
    const datasource = options.datasource; 
    const samplingConfig = options.samplingConfig
    const sqlOptions = normalizeSqlOptions(options.sqlOptions);

    let filterAxisItems = options.filterAxisItems;
    if ( filterAxisItems && filterAxisItems.length ) {
      const axisIds = Object.keys(itemAxes);
      if (axisIds.length) {
        switch (axisIds.length) {
          case 1:
            filterAxisItems = filterAxisItems.filter( filterAxisItem => {
              if ( !QueryAxisItem.isAxisAggregate( filterAxisItem ) ){
                return true;
              }
              const partitionByItems = filterAxisItem.partitionByItems;
              if ( partitionByItems.some( partitionByItem => partitionByItem.axis !== axisIds[0] ) ) {
                return false;
              }
              return true;
            });
            break;
        }
      }
    }
    const filterAxisItemsByNestingStage = SqlQueryGenerator.#getFilterItemsByNestingStage(filterAxisItems);
    const ctes = SqlQueryGenerator.#getUnnestingStages(
      datasource,
      queryAxisItems, 
      filterAxisItemsByNestingStage
    );
    
    let cte = ctes[ctes.length -1];
    if ( 
      cte.items.some( item => QueryAxisItem.isAxisAggregate( item ) ) ||
      filterAxisItems && filterAxisItems.some( filterAxisItem => QueryAxisItem.isAxisAggregate(filterAxisItem) )
    ) {
      SqlQueryGenerator.#createAxisAggregateStage(ctes);
    }
    cte = ctes.pop();

    options.samplingConfig = ctes.length ? undefined : samplingConfig;
    let sql = SqlQueryGenerator.#getSqlSelectStatementForFinalStage(cte, options);
    
    const sqls = ctes.map((cte, index) => {
      sqlOptions.samplingConfig = index === 0 ? samplingConfig : undefined;
      const sql = SqlQueryGenerator.#getSqlSelectStatementForIntermediateStage(cte, sqlOptions);
      return sql;
    });
    
    if (options.finalStateAsCte === true) {
      sql = sql.replace(/\n/g, '\n  ');
      sqls.push(`${quoteIdentifierWhenRequired(options.cteName)} AS (\n  ${sql}\n)`);
      sql = '';
    }
    const withSql = sqls.length ? `WITH ${sqls.join('\n,')}\n` : '';
    sql = withSql + sql;
    return sql;
  }

}