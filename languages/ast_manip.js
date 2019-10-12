// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2017-2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const ThingTalk = require('thingtalk');
const Ast = ThingTalk.Ast;
const Type = ThingTalk.Type;

const { isUnaryTableToTableOp,
        isUnaryStreamToTableOp,
        isUnaryStreamToStreamOp,
        isUnaryTableToStreamOp } = require('./utils');
const { notifyAction } = ThingTalk.Generate;
const { clean, pluralize } = require('../lib/utils');
const { coin } = require('../lib/random');

function typeToStringSafe(type) {
    if (type.isArray)
        return 'Array__' + typeToStringSafe(type.elem);
    else if (type.isEntity)
        return 'Entity__' + type.type.replace(':', '__');
    else if (type.isMeasure)
        return 'Measure_' + type.unit;
    else if (type.isEnum)
        return 'Enum__' + type.entries.join('__');
    else
        return String(type);
}

function findFunctionNameTable(table) {
    if (table.isInvocation)
        return [table.invocation.selector.kind + ':' + table.invocation.channel];

    if (isUnaryTableToTableOp(table))
        return findFunctionNameTable(table.table);

    if (isUnaryStreamToTableOp(table))
        return findFunctionNameStream(table.stream);

    if (table.isJoin)
        return findFunctionNameTable(table.lhs).concat(findFunctionNameTable(table.rhs));

    throw new TypeError();
}

function findFunctionNameStream(stream) {
    if (stream.isTimer || stream.isAtTimer)
        return [];

    if (isUnaryStreamToStreamOp(stream))
        return findFunctionNameStream(stream.stream);

    if (isUnaryTableToStreamOp(stream))
        return findFunctionNameTable(stream.table);

    if (stream.isJoin)
        return findFunctionNameStream(stream.stream).concat(findFunctionNameTable(stream.table));

    throw new TypeError('??? ' + stream);
}

function isSelfJoinStream(stream) {
    let functions = findFunctionNameStream(stream);
    if (functions.length > 1) {
        if (!Array.isArray(functions))
            throw new TypeError('??? ' + functions);
        functions.sort();
        for (let i = 0; i < functions.length-1; i++) {
            if (functions[i] === functions[i+1])
                return true;
        }
    }
    return false;
}

function checkNotSelfJoinStream(stream) {
    if (isSelfJoinStream(stream))
        return null;
    return stream;
}

function betaReduce(ast, pname, value) {
    const clone = ast.clone();

    let found = false;
    for (let slot of clone.iterateSlots2({})) {
        if (slot instanceof Ast.Selector)
            continue;

        if (pname in slot.scope) {
            // if the parameter is in scope of the slot, it means we're in a filter andthe same parameter name
            // is returned by the stream/table, which shadows the example/declaration parameter we're
            // trying to replace, hence we ignore this slot
            continue;
        }

        const varref = slot.get();
        if (varref.isVarRef && varref.name === pname) {
            slot.set(value);
            found = true;
        }
    }

    if (found) {
        // the parameter should not be in the schema for the table/stream, but sentence-generator/index.js
        // messes with the schema ands adds it there (to do quick checks of parameter passing), so here
        // we remove it again
        clone.schema = ast.schema.removeArgument(pname);
    } else {
        // in case schema was not copied by .clone() (eg if ast is a Program, which does not normally have a .schema)
        clone.schema = ast.schema;
    }

    return clone;
}

function unassignInputParameter(schema, passign, pname) {
    let arg = schema.getArgument(passign).clone();
    arg.name = pname;
    return schema.addArguments([arg]);
}

// perform eta reduction
// (turn (\(x) -> f(x)) into just f
function etaReduceInvocation(invocation, pname) {
    let clone = new Ast.Invocation(invocation.selector, invocation.channel,
        Array.from(invocation.in_params), null);
    let passign;
    for (let i = 0; i < clone.in_params.length; i++) {
        let inParam = clone.in_params[i];
        if (inParam.value.isVarRef && inParam.value.name === pname) {
            passign = inParam.name;
            clone.in_params.splice(i, 1);
            break;
        }
    }
    if (!passign)
        return [undefined, clone];
    clone.schema = unassignInputParameter(invocation.schema, passign, pname);

    return [passign, clone];
}

function etaReduceTable(table, pname) {
    if (!table.schema.hasArgument(pname) || !table.schema.isArgInput(pname))
        return [undefined, table];
    if (table.isInvocation) {
        let [passign, clone] = etaReduceInvocation(table.invocation, pname);
        return [passign, new Ast.Table.Invocation(clone, clone.schema)];
    } else if (table.isFilter) {
        let [passign, clone] = etaReduceTable(table.table, pname);
        return [passign, new Ast.Table.Filter(clone, table.filter, clone.schema)];
    } else {
        // TODO
        return [undefined, table];
    }
}

function makeFilter($options, param, op, value, negate = false) {
    // param is a Value.VarRef
    //console.log('param: ' + param.name);
    let vtype = value.getType();
    if (op === 'contains')
        vtype = Type.Array(vtype);
    if (!$options.params.out.has(param.name + '+' + vtype))
        return null;
    if ($options.params.blacklist.has(param.name + '+' + vtype))
        return null;

    let f = new Ast.BooleanExpression.Atom(param.name, op, value);
    if (negate)
        return new Ast.BooleanExpression.Not(f);
    else
        return f;
}

function makeAndFilter($options, param, op, values, negate=false) {
    const operands  = values.map((v) => makeFilter($options, param, op, v));
    if (operands.includes(null))
        return null;
    const f = new Ast.BooleanExpression.And(operands);
    if (negate)
        return new Ast.BooleanExpression.Not(f);
    return f;
}

function makeOrFilter($options, param, op, values, negate=false) {
    const operands  = values.map((v) => makeFilter($options, param, op, v, negate));
    if (operands.includes(null))
        return null;
    const f = new Ast.BooleanExpression.Or(operands);
    if (negate)
        return new Ast.BooleanExpression.Not(f);
    return f;
}


function makeListExpression($options, param, filter) {
    if (filter) {
        // TODO: handle more complicated filters
        if (!filter.isAtom)
            return null;
        if (filter.name === 'value') {
            if ($options.params.out.has(`${param.name}+Array(Compound)`))
                return null;
        } else {
            if (!(param.name in $options.compoundArrays))
                return null;
            const type = $options.compoundArrays[param.name];
            if (!(filter.name in type.fields))
                return null;
        }
        let vtype = filter.value.getType();
        if (!$options.params.out.has(`${filter.name}+${vtype}`))
            return null;
    }
    return new Ast.ListExpression(param.name, filter);
}

function makeAggregateFilter($options, param, filter, aggregationOp, field, op, value) {
    const list = makeListExpression($options, param, filter);
    if (!list)
        return null;
    if (aggregationOp === 'count') {
        if (!value.getType().isNumber)
            return null;
        const agg = new Ast.ScalarExpression.Aggregation(aggregationOp, field, list);
        return new Ast.BooleanExpression.Compute(agg, op, value);
    } else if (['sum', 'avg', 'max', 'min'].includes(aggregationOp)) {
        const vtype = value.getType();
        if (field) {
            if (!$options.params.out.has(`${field.name}+${vtype}`))
                return null;
        } else {
            if (!$options.params.out.has(`${param.name}+Array(${vtype})`))
                return null;
        }
        const agg = new Ast.ScalarExpression.Aggregation(aggregationOp, field ? field.name : null, list);
        return new Ast.BooleanExpression.Compute(agg, op, value);
    }
    return null;
}

function makeEdgeFilterStream(proj, op, value, $options) {
    if (proj.table.isAggregation)
        return null;

    let f = new Ast.BooleanExpression.Atom(proj.args[0], op, value);
    if (!checkFilter(proj.table, f))
        return null;
    if (!proj.schema.is_monitorable || proj.schema.is_list)
        return null;
    let outParams = Object.keys(proj.table.schema.out);
    if (outParams.length === 1 && $options.flags.turking)
        return null;

    return new Ast.Stream.EdgeFilter(new Ast.Stream.Monitor(proj.table, null, proj.table.schema), f, proj.table.schema);
}

function addUnit(unit, num) {
    if (num.isVarRef) {
        let v = new Ast.Value.VarRef(num.name + '__' + unit);
        v.getType = () => Type.Measure(unit);
        return v;
    } else {
        return new Ast.Value.Measure(num.value, unit);
    }
}

function makeSingleFieldProjection($options, ftype, ptype, table, outParam) {
    assert(ftype === 'table' || ftype === 'stream');

    const name = outParam.name;
    if ($options.flags.schema_org) {
        if (name === 'id')
            return null;
    }
    if (!table.schema.out[name] || !Type.isAssignable(table.schema.out[name], ptype))
        return null;

    if (ftype === 'table') {
        if (name === 'picture_url' && $options.flags.turking)
            return null;
        const newSchema = table.schema.filterArguments((arg) => arg.direction !== Ast.ArgDirection.OUT || arg.name === name);
        return new Ast.Table.Projection(table, [name], newSchema);
    } else {
        if (!table.schema.is_monitorable)
            return null;
        const stream = new Ast.Stream.Monitor(table, null, table.schema);
        const newSchema = stream.schema.filterArguments((arg) => arg.direction !== Ast.ArgDirection.OUT || arg.name === name);
        return new Ast.Stream.Projection(stream, [name], newSchema);
    }
}


function makeMultiFieldProjection($options, ftype, table, outParams) {
    if (coin(0.9998, $options.rng))
        return null;
    const names = [];
    for (let outParam of outParams) {
        const name = outParam.name;
        if ($options.flags.schema_org) {
            if (name === 'id')
                return null;
        }
        if (!table.schema.out[name])
            return null;

        if (ftype === 'table') {
            if (name === 'picture_url' && $options.flags.turking)
                return null;
        } else {
            if (!table.schema.is_monitorable)
                return null;
        }

        names.push(name);
    }

    if (ftype === 'table') {
        const newSchema = table.schema.filterArguments((arg) => arg.direction !== Ast.ArgDirection.OUT || names.includes(arg.name));
        return new Ast.Table.Projection(table, names, newSchema);
    } else {
        const stream = new Ast.Stream.Monitor(table, null, table.schema);
        const newSchema = stream.schema.filterArguments((arg) => arg.direction !== Ast.ArgDirection.OUT || names.includes(arg.name));
        return new Ast.Stream.Projection(stream, names, newSchema);
    }
}

function makeArgMaxMinTable(table, pname, direction) {
    if (!table.schema.out[pname] || !table.schema.out[pname].isNumeric())
        return null;
    if (!table.schema.is_list || table.isIndex) //avoid conflict with primitives
        return null;
    if (hasUniqueFilter(table))
        return null;

    for (let [,filter] of iterateFilters(table)) {
        for (let atom of iterateFields(filter)) {
            if (atom.name === pname)
                return null;
        }
    }

    const t_sort = new Ast.Table.Sort(table, pname, direction, table.schema);
    return new Ast.Table.Index(t_sort, [new Ast.Value.Number(1)], table.schema);
}

function makeProgram(rule, principal = null) {
    // FIXME: A hack for schema.org only to drop certain programs
    let table = rule.table;
    if (table) {
        // projection won't help here
        if (table.isProjection)
            table = table.table;

        // if a table is just a plain invocation, drop it
        if (table.isInvocation)
            return null;

        if (table.isFilter) {
            let filteredOnName = false;
            let filteredOthers = false;
            for (let [, filter] of iterateFilters(table)) {
                for (let atom of iterateFields(filter)) {
                    if (atom.name === 'name')
                        filteredOnName = true;
                    else
                        filteredOthers = true;
                }
            }
            if (filteredOnName && !filteredOthers)
                return null;
        }
    }
    return new Ast.Program([], [], [rule], principal);
}

function combineStreamCommand(stream, command) {
    if (command.table) {
        stream = new Ast.Stream.Join(stream, command.table, [], command.table.schema);
        if (isSelfJoinStream(stream))
            return null;
        return new Ast.Statement.Rule(stream, command.actions);
    } else {
        return new Ast.Statement.Rule(stream, command.actions);
    }
}

function checkFilter(table, filter) {
    if (filter.isNot)
        filter = filter.expr;
    if (filter.isExternal)
        return true;
    if (filter.isAnd || filter.isOr ) {
        for (let operands of filter.operands) {
            if (!checkFilter(table, operands))
                return false;
        }
        return true;
    }

    let vtype, ptype, ftype;

    if (filter.isCompute) {
        if (!filter.lhs.isAggregation)
            return false;
        let name = filter.lhs.list.name;
        if (!table.schema.out[name])
            return false;

        ptype = table.schema.out[name];
        if (!ptype.isArray)
            return false;

        if (filter.lhs.operator === 'count') {
            vtype = Type.Number;
        } else {
            if (filter.lhs.field && filter.lhs.field in ptype.elem.fields)
                ftype = ptype.elem.fields[filter.lhs.field].type;
            else
                ftype = ptype.elem;
            vtype = ftype;
        }
        return filter.rhs.getType().equals(vtype);
    } else if (filter.isAtom) {
        if (!table.schema.out[filter.name])
            return false;

        ptype = table.schema.out[filter.name];
        vtype = ptype;
        if (filter.operator === 'contains') {
            if (!vtype.isArray)
                return false;
            vtype = ptype.elem;
        } else if (filter.operator === 'in_array') {
            vtype = Type.Array(ptype);
        }
        return filter.value.getType().equals(vtype);
    } else {
        return false;
    }
}

function *iterateFilters(table) {
    if (table.isInvocation || table.isVarRef || table.isResultRef)
        return;

    if (table.isFilter) {
        yield [table.schema, table.filter];
    } else if (table.isJoin) {
        yield *iterateFilters(table.lhs);
        yield *iterateFilters(table.rhs);
    } else {
        yield *iterateFilters(table.table);
    }
}

function *iterateFields(filter) {
    if (filter.isAnd) {
        for (let operand of filter.operands)
            yield *iterateFields(operand);
    } else if (filter.isNot) {
        yield *iterateFields(filter.expr);
    } else if (filter.isAtom) {
        yield filter;
    }
}

function hasUniqueFilter(table) {
    for (let [schema, filter] of iterateFilters(table)) {
        for (let atom of iterateFields(filter)) {
            if (schema.getArgument(atom.name).unique)
                return true;
        }
    }
    return false;
}

function checkFilterUniqueness(table, filter) {
    // FIXME (thingtalk issue #105)
    if (filter.isAnd || filter.isOr)
        return filter.operands.some((f) => checkFilterUniqueness(table, f));

    if (filter.isExternal)
        return false;

    if (filter.isNot)
        filter = filter.expr;

    if (filter.isTrue || filter.isFalse)
        return false;

    if (filter.isCompute)
        return false;

    return table.schema.getArgument(filter.name).unique;
}

function addFilter(table, filter, $options, forceAdd = false) {
    // when an "unique" parameter has been used in the table
    if (table.schema.no_filter)
        return null;

    if (table.isProjection) {
        const added = addFilter(table.table, filter, $options, forceAdd);
        if (added === null)
            return null;
        return new Ast.Table.Projection(added, table.args, table.schema);
    }

    // under normal conditions, we don't want to add a second filter to an already
    // filtered table (= add 2 filters) for turking, because the resulting sentence
    // would be clunky
    //
    // different story is when the filter being added is in the next sentence,
    // because then we expect to paraphrase only the second filter, and hopefully not mess up
    //
    // hence, addFilterToProgram/addFilterToPolicy (which are contextual) pass forceAdd = true,
    // which skips the 2 filter heuristic
    if (!forceAdd && !$options.flags.multifilters && table.isFilter && $options.flags.turking)
        return null;

    if (table.isFilter) {
        // if we already have a filter, don't add a new complex filter
        if (!forceAdd && !filter.isAtom && !(filter.isNot && filter.expr.isAtom))
             return null;

        if (checkFilterUniqueness(table, filter))
            return null;

        if (hasUniqueFilter(table))
            return null;

        let existing = table.filter;
        let atom = filter.isNot ? filter.expr : filter;
        // check that we don't create a non-sensical filter, eg.
        // p == X && p == Y, or p > X && p > Y
        let operands = existing.isAnd ? existing.operands : [existing];
        for (let operand of operands) {
            if (operand.isAtom && operand.name === atom.name &&
                (operand.operator === atom.operator ||
                 operand.operator === '==' ||
                 atom.operator === '==' ||
                 operand.operator === 'in_array' ||
                 atom.operator === 'in_array'))
                return null;
        }

        let newFilter = Ast.BooleanExpression.And([existing, filter]).optimize();
        return new Ast.Table.Filter(table.table, newFilter, table.schema);
    }

    // FIXME deal with the other table types (maybe)

    const schema = table.schema.clone();
    if (checkFilterUniqueness(table, filter))
        schema.no_filter = true;
    return new Ast.Table.Filter(table, filter, schema);
}

function checkAndAddFitlter(table, filter, $options) {
    if (!table.schema.is_list)
        return null;
    if (!checkFilter(table, filter))
        return null;
    return addFilter(table, filter, $options);
}

function addFilterToProgram(program, filter, $options) {
    if (!program.rules[0].stream && !program.rules[0].table)
        return null;

    if (!program.rules[0].stream || !program.rules[0].stream.isMonitor)
        return null;

    const clone = program.clone();

    if (clone.rules[0].stream) {
        if (!checkFilter(clone.rules[0].stream.table, filter))
            return null;

        clone.rules[0].stream.table = addFilter(clone.rules[0].stream.table, filter, $options, true);
        if (!clone.rules[0].stream.table)
            return null;
    } else {
        clone.rules[0].table = addFilter(clone.rules[0].table, filter, $options, true);
        if (!clone.rules[0].table)
            return null;
    }

    return clone;
}

function addFilterToPolicy(policy, filter, $options) {
    const clone = policy.clone();

    if (clone.action.isSpecified) {
        if (checkFilter(clone.action, filter)) {
            clone.action.filter = Ast.BooleanExpression.And([clone.action.filter, filter]).optimize();
            return clone;
        }
    }

    if (clone.query.isSpecified) {
        if (checkFilter(clone.query, filter)) {
            clone.query.filter = Ast.BooleanExpression.And([clone.query.filter, filter]).optimize();
            return clone;
        }
    }

    if (!filter.isExternal)
        return null;

    clone.principal = Ast.BooleanExpression.And([clone.principal, filter]).optimize();
    return clone;
}

function tableToStream(table, projArg) {
    if (!table.schema.is_monitorable)
        return null;
    let stream;
    if (table.isFilter && !table.schema.is_list)
        stream = new Ast.Stream.EdgeFilter(new Ast.Stream.Monitor(table.table, projArg, table.table.schema), table.filter, table.table.schema);
    else
        stream = new Ast.Stream.Monitor(table, projArg, table.schema);
    return stream;
}

function inParamsToFilters(in_params) {
    const operands = [];
    for (let param of in_params) {
        if (param.value.isUndefined)
            continue;
        operands.push(Ast.BooleanExpression.Atom(param.name, '==', param.value));
    }
    return Ast.BooleanExpression.And(operands);
}

function makePolicy(principal, table, action) {
    const policyAction = action ?
        new Ast.PermissionFunction.Specified(action.invocation.selector.kind, action.invocation.channel, inParamsToFilters(action.invocation.in_params), action.invocation.schema) :
        Ast.PermissionFunction.Builtin;

    let policyQuery = Ast.PermissionFunction.Builtin;
    if (table) {
        /*if (!table.schema.remote_confirmation || table.schema.remote_confirmation.indexOf('$__person') < 0)
            return null;*/

        if (table.isFilter && table.table.isInvocation) {
            const queryfilter = Ast.BooleanExpression.And([inParamsToFilters(table.table.invocation.in_params), table.filter]);
            policyQuery = new Ast.PermissionFunction.Specified(table.table.invocation.selector.kind, table.table.invocation.channel, queryfilter,
                table.table.invocation.schema);
        } else if (table.isInvocation) {
            const queryfilter = inParamsToFilters(table.invocation.in_params);
            policyQuery = new Ast.PermissionFunction.Specified(table.invocation.selector.kind, table.invocation.channel, queryfilter,
                table.invocation.schema);
        } else {
            return null;
        }
    }

    const sourcepredicate = principal ?
        Ast.BooleanExpression.Atom('source', '==', principal) : Ast.BooleanExpression.True;

    return new Ast.PermissionRule(sourcepredicate, policyQuery, policyAction);
}

function builtinSayAction($options, pname) {
    let selector = new Ast.Selector.Device('org.thingpedia.builtin.thingengine.builtin', null, null);
    if (pname instanceof Ast.Value) {
        let param = new Ast.InputParam('message', pname);
        return new Ast.Action.Invocation(Ast.Invocation(selector, 'say', [param], $options.standardSchemas.say),
            $options.standardSchemas.say.removeArgument('message'));
    } if (pname) {
        let param = new Ast.InputParam('message', new Ast.Value.VarRef(pname));
        return new Ast.Action.Invocation(new Ast.Invocation(selector, 'say', [param], $options.standardSchemas.say),
            $options.standardSchemas.say.removeArgument('message'));
    } else {
        return new Ast.Action.Invocation(new Ast.Invocation(selector, 'say', [], $options.standardSchemas.say),
            $options.standardSchemas.say.removeArgument('message'));
    }
}

function locationGetPredicate($options, loc, negate = false) {
    let filter = Ast.BooleanExpression.Atom('location', '==', loc);
    if (negate)
        filter = Ast.BooleanExpression.Not(filter);

    return new Ast.BooleanExpression.External(Ast.Selector.Device('org.thingpedia.builtin.thingengine.builtin',null,null),'get_gps', [], filter,
        $options.standardSchemas.get_gps);
}

function timeGetPredicate($options, low, high) {
    let operands = [];

    if (low)
        operands.push(Ast.BooleanExpression.Atom('time', '>=', low));
    if (high)
        operands.push(Ast.BooleanExpression.Atom('time', '<=', high));
    const filter = Ast.BooleanExpression.And(operands);
    return new Ast.BooleanExpression.External(Ast.Selector.Device('org.thingpedia.builtin.thingengine.builtin',null,null),'get_time', [], filter,
        $options.standardSchemas.get_time);
}

function hasGetPredicate(filter) {
    if (filter.isAnd || filter.isOr) {
        for (let op of filter.operands) {
            if (hasGetPredicate(op))
                return true;
        }
        return false;
    }
    if (filter.isNot)
        return hasGetPredicate(filter.expr);
    return filter.isExternal;
}

function makeGetPredicate(proj, op, value, negate = false) {
    if (!proj.table.isInvocation)
        return null;
    let arg = proj.args[0];
    let filter = Ast.BooleanExpression.Atom(arg, op, value);
    if (negate)
        filter = Ast.BooleanExpression.Not(filter);
    const selector = proj.table.invocation.selector;
    const channel = proj.table.invocation.channel;
    const schema = proj.table.invocation.schema;
    if (!schema.out[arg].equals(value.getType()))
        return null;
    return new Ast.BooleanExpression.External(selector, channel, proj.table.invocation.in_params, filter, proj.table.invocation.schema);
}

// perform a join with parameter passing
function mergeSchemas(functionType, lhsSchema, rhsSchema, passign) {
    // handle parameter name conflicts by having the second primitive win
    const newArgNames = new Set;
    const newArgs = [];
    for (let arg of rhsSchema.iterateArguments()) {
        if (arg.name === passign)
            continue;
        newArgNames.add(arg.name);
        newArgs.push(arg);
    }
    for (let arg of lhsSchema.iterateArguments()) {
        if (newArgNames.has(arg.name))
            continue;
        /*if (!lhsSchema.isArgInput(arg.name))
            continue;*/
        newArgNames.add(arg.name);
        newArgs.push(arg);
    }

    return new Ast.ExpressionSignature(functionType,
        [], // extends
        newArgs, // args
        lhsSchema.is_list || rhsSchema.is_list, // is_list
        lhsSchema.is_monitorable && rhsSchema.is_monitorable // is_monitorable
    );
}

function filterTableJoin(into, filteredTable) {
    if (filteredTable === null)
        return null;
    if (!filteredTable.isFilter)
        return null;
    let tableName;
    for (let [, invocation] of filteredTable.iteratePrimitives())
        tableName = invocation.channel;
    let passign;
    for (let arg of into.schema.iterateArguments()) {
        if (arg.name !== 'id' && arg.type.isEntity && arg.type.type.substring('org.schema:'.length) === tableName)
            passign = arg;
    }
    if (!passign)
        return null;

    const newSchema = mergeSchemas('query', filteredTable.schema, into.schema, '');

    const join = new Ast.Table.Join(filteredTable, into, [], newSchema);
    const filter = new Ast.BooleanExpression.Atom(
        passign.name, '==', new Ast.Value.VarRef('id')
    );
    return new Ast.Table.Filter(join, filter, newSchema);
}

function arrayFilterTableJoin(into, filteredTable) {
    if (filteredTable === null)
        return null;
    if (!filteredTable.isFilter)
        return null;
    let tableName;
    for (let [, invocation] of filteredTable.iteratePrimitives())
        tableName = invocation.channel;
    let passign;
    for (let arg of into.schema.iterateArguments()) {
        if (arg.type.isArray && arg.type.elem.isEntity && arg.type.elem.type.substring('org.schema:'.length) === tableName)
            passign = arg;
    }
    if (!passign)
        return null;

    const newSchema = mergeSchemas('query', filteredTable.schema, into.schema, '');

    const join = new Ast.Table.Join(filteredTable, into, [], newSchema);
    const filter = new Ast.BooleanExpression.Atom(
        passign.name, 'contains', new Ast.Value.VarRef('id')
    );
    return new Ast.Table.Filter(join, filter, newSchema);
}

function tableJoinReplacePlaceholder(into, pname, projection) {
    if (projection === null)
        return null;
    if (!projection.isProjection || !projection.table || projection.args.length !== 1)
        throw new TypeError('???');
    const joinArg = projection.args[0];
    if (joinArg === '$event' && ['p_body', 'p_message', 'p_caption', 'p_status'].indexOf(pname) < 0)
        return null;
    const ptype = joinArg === '$event' ? Type.String : projection.schema.out[joinArg];
    const intotype = into.schema.inReq[pname];
    if (!intotype || !ptype.equals(intotype))
        return null;

    let [passign, etaReduced] = etaReduceTable(into, pname);
    if (passign === undefined) {
        //console.error(`Ignored join between ${into} and ${projection}: cannot find parameter ${pname}`);
        return null;
    }
    //console.log('passign: ' + passign + ', ptype: ' + ptype);

    const newSchema = mergeSchemas('query', projection.schema, etaReduced.schema, passign);
    let replacement = joinArg === '$event' ? new Ast.Value.Event(null) : new Ast.Value.VarRef(joinArg);
    return new Ast.Table.Join(projection.table, etaReduced, [new Ast.InputParam(passign, replacement)], newSchema);
}

function actionReplaceParamWith(into, pname, projection) {
    const joinArg = projection.args[0];
    if (joinArg === '$event' && ['p_body', 'p_message', 'p_caption', 'p_status'].indexOf(pname) < 0)
        return null;
    const ptype = joinArg === '$event' ? Type.String : projection.schema.out[joinArg];
    const intotype = into.schema.inReq[pname];
    if (!intotype || !ptype.equals(intotype))
        return null;

    const replacement = joinArg === '$event' ? new Ast.Value.Event(null) : new Ast.Value.VarRef(joinArg);
    return betaReduce(into, pname, replacement);
}

function actionReplaceParamWithTable(into, pname, projection) {
    if (projection === null)
        return null;
    if (!projection.isProjection || !projection.table || projection.args.length !== 1)
        throw new TypeError('???');
    const reduced = actionReplaceParamWith(into, pname, projection);
    if (reduced === null)
        return null;
    return new Ast.Statement.Command(projection.table, [reduced]);
}

function actionReplaceParamWithStream(into, pname, projection) {
    if (projection === null)
        return null;
    if (!projection.isProjection || !projection.stream || projection.args.length !== 1)
        throw new TypeError('???');
    const reduced = actionReplaceParamWith(into, pname, projection);
    if (reduced === null)
        return null;
    return new Ast.Statement.Rule(projection.stream, [reduced]);
}

function getDoCommand(command, pname, joinArg) {
    //if (command.actions.length !== 1 || command.actions[0].selector.isBuiltin)
    //    throw new TypeError('???');
    let actiontype = command.actions[0].schema.inReq[pname];
    if (!actiontype)
        return null;
    let commandtype = joinArg.isEvent ? Type.String : command.table.schema.out[joinArg.name];
    if (!commandtype || !commandtype.equals(actiontype))
        return null;

    let reduced = betaReduce(command.actions[0], pname, joinArg);
    if (reduced === null)
        return null;
    return new Ast.Statement.Command(command.table, [reduced]);
}

function whenDoRule(rule, pname, joinArg) {
    //if (rule.actions.length !== 1 || rule.actions[0].selector.isBuiltin)
    //    throw new TypeError('???');
    let actiontype = rule.actions[0].schema.inReq[pname];
    if (!actiontype)
        return null;
    let commandtype = joinArg.isEvent ? Type.String : rule.stream.schema.out[joinArg.name];
    if (!commandtype || !commandtype.equals(actiontype))
        return null;
    if (joinArg.isEvent && (rule.stream.isTimer || rule.stream.isAtTimer))
        return null;

    let reduced = betaReduce(rule.actions[0], pname, joinArg);
    if (reduced === null)
        return null;
    return new Ast.Statement.Rule(rule.stream, [reduced]);
}

function whenGetStream(stream, pname, joinArg) {
    if (!stream.isJoin)
        throw new TypeError('???');
    let commandtype = stream.table.schema.inReq[pname];
    if (!commandtype)
        return null;
    let streamtype = joinArg.isEvent ? Type.String : stream.stream.schema.out[joinArg.name];
    if (!streamtype || !streamtype.equals(commandtype))
        return null;
    if (joinArg.isEvent && (stream.stream.isTimer || stream.stream.isAtTimer))
        return null;

    let [passign, etaReduced] = etaReduceTable(stream.table, pname);
    if (passign === undefined) {
        //console.error(`Ignored join between ${into} and ${projection}: cannot find parameter ${pname}`);
        return null;
    }
    //console.log('passign: ' + passign + ', ptype: ' + ptype);

    const newSchema = mergeSchemas('stream', stream.schema, etaReduced.schema, passign);
    return new Ast.Stream.Join(stream.stream, etaReduced, stream.in_params.concat([new Ast.InputParam(passign, joinArg)]), newSchema);
}

function isConstantAssignable(value, ptype) {
    if (!ptype)
        return false;
    if (!Type.isAssignable(value.getType(), ptype))
        return false;
    if (value.getType().isEnum && (!ptype.isEnum || ptype.entries.indexOf(value.value) < 0))
        return false;
    return true;
}

function replacePlaceholderWithConstant(lhs, pname, value) {
    let ptype = lhs.schema.inReq[pname];
    if (!isConstantAssignable(value, ptype))
        return null;
    if (ptype.isEnum && ptype.entries.indexOf(value.toJS()) < 0)
        return null;
    //if (pname === 'p_low')
    //    console.log('p_low := ' + ptype + ' / ' + value.getType());
    if (value.isDate && value.value === null && value.offset === null)
        return null;
    return betaReduce(lhs, pname, value);
}

function replacePlaceholderWithUndefined(lhs, pname, typestr) {
    if (!lhs.schema.inReq[pname])
        return null;
    if (typestr !== typeToStringSafe(lhs.schema.inReq[pname]))
        return null;
    return betaReduce(lhs, pname, new Ast.Value.Undefined(true));
}

function sayProjectionProgram($options, proj) {
    // this function is also used for aggregation
    if (proj.isProjection) {
        if (proj.args.length === 1 && proj.args[0] === 'picture_url')
            return null;
        // if the function only contains one parameter, do not generate projection for it
        if (Object.keys(proj.table.schema.out).length === 1)
            return null;
        if (!$options.flags.projection)
            return null;
        if (proj.args.includes('name')) {
            if (proj.args.length === 1)
                proj = proj.table;
            else
                proj.args = proj.args.filter((a) => a !== 'name');
        }
    }
    return makeProgram(new Ast.Statement.Command(proj, [notifyAction()]));
}

function isQueryProgram(program) {
    if (!program.isProgram)
        return false;

    let hasTrigger = program.rules.length > 0 && program.rules.some((r) => r.isRule);
    if (hasTrigger)
        return false;

    for (let [primType, prim] of program.iteratePrimitives(false)) {
        if (prim.selector.isBuiltin)
            continue;
        if (primType === 'action')
            return false;
    }

    return true;
}

function isContinuousProgram(program) {
    if (!program.isProgram)
        return false;

    for (let rule of program.rules) {
        if (rule.isRule)
            return true;
    }
    return false;
}

function isCompleteCommand(thingtalk) {
    for (let [, slot] of thingtalk.iterateSlots()) {
        if (slot instanceof Ast.Selector)
            continue;
        if (slot.value.isUndefined)
            return false;
    }
    return true;
}

function addTimerToProgram(program, timer) {
    const newrules = program.rules.map((r) => {
        if (r.isAssignment)
            return r;
        if (r.table)
            return new Ast.Statement.Rule(Ast.Stream.Join(timer, r.table, [], r.table.schema), r.actions);
        else
            return new Ast.Statement.Rule(timer, r.actions);
    });
    return new Ast.Program(program.classes, program.declarations, newrules, program.principal, program.oninputs);
}

function makeMonitor(program) {
    const newrules = program.rules.map((r) => {
        return new Ast.Statement.Rule(new Ast.Stream.Monitor(r.table, null, r.table.schema), r.actions);
    });
    return new Ast.Program(program.classes, program.declarations, newrules, program.principal, program.oninputs);
}

function replaceAnyParameterFromContext(context, newValue) {
    const type = newValue.getType();
    assert(!type.isAny);

    const slotsOfType = [];

    const clone = context.clone();
    for (let [schema, slot] of clone.iterateSlots()) {
        if (slot instanceof Ast.Selector)
            continue;
        if (slot.value.isVarRef)
            continue;
        let argname = slot.name;
        let type = schema.inReq[argname] || schema.inOpt[argname] || schema.out[argname];
        if (slot instanceof Ast.BooleanExpression && slot.operator === 'contains')
            type = type.elem;

        if (isConstantAssignable(newValue, type))
            slotsOfType.push(slot);
    }

    if (slotsOfType.length !== 1)
        return null;

    slotsOfType[0].value = newValue;
    return clone;
}

function fillNextSlot(program, newValue) {
    for (let [schema, slot] of program.iterateSlots()) {
        if (slot instanceof Ast.Selector)
            continue;
        if (slot.value.isVarRef || !slot.value.isUndefined)
            continue;

        let argname = slot.name;
        let type = schema.inReq[argname] || schema.inOpt[argname] || schema.out[argname];
        if (slot instanceof Ast.BooleanExpression && slot.operator === 'contains')
            type = type.elem;
        if (!isConstantAssignable(newValue, type))
            return null;

        return new Ast.Input.Bookkeeping(
            new Ast.BookkeepingIntent.Answer(newValue)
        );
    }

    return null;
}

function makeExampleFromQuery(id, q) {
    const examples = [];
    const device = new Ast.Selector.Device(q.class.name, null, null);
    const invocation = new Ast.Invocation(device, q.name, [], q);
    const canonical = invocation.canonical ? invocation.canonical : clean(q.name);
    const canonicals = [canonical];
    const pluralized = pluralize(canonical);
    if (pluralized !== canonical)
        canonicals.push(pluralized);
    const table = new Ast.Table.Invocation(invocation, q);
    examples.push(new Ast.Example(
        -1,
        'query',
        {},
        table,
        canonicals,
        canonicals,
        {}
    ));
    if (id && id.has_ner_support === 1) {
        const filter = new Ast.BooleanExpression.Atom('id', '==', new Ast.Value.VarRef('p_id'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_id: Type.Entity(id.type) },
            new Ast.Table.Filter(table, filter, q),
            [`\${p_id}`],
            [`\${p_id}`],
            {}
        ));
    }
    if (id && id.has_ner_support === 1) {
        const idfilter = new Ast.BooleanExpression.Atom('id', '==', new Ast.Value.VarRef('p_id'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_id: Type.Entity(id.type) },
            new Ast.Table.Filter(table, idfilter, q),
            [`\${p_id}`],
            [`\${p_id}`],
            {}
        ));
        const namefilter = new Ast.BooleanExpression.Atom('name', '=~', new Ast.Value.VarRef('p_name'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_name: Type.String },
            new Ast.Table.Filter(table, namefilter, q),
            [`\${p_name}`],
            [`\${p_name}`],
            {}
        ));
    }
    return examples;
}

function makeExampleFromAction(a) {
    const examples = [];
    const device = new Ast.Selector.Device(a.class.name, null, null);
    const invocation = new Ast.Invocation(device, a.name, [], a);
    const canonical = invocation.canonical ? invocation.canonical : clean(a.name);
    const canonicals = [canonical];
    const pluralized = pluralize(canonical);
    if (pluralized !== canonical)
        canonicals.push(pluralized);
    examples.push(new Ast.Example(
        -1,
        'action',
        {},
        new Ast.Action.Invocation(invocation, a),
        canonicals,
        canonicals,
        {}
    ));
    return examples;
}

function hasConflictParam(table, pname, operation) {
    function cleanName(name) {
        if (name.endsWith(' value'))
            name = name.substring(0, name.length - ' value'.length);
        if (name.includes('.')) {
            const components = name.split('.');
            name = components[components.length - 1];
        }
        return name;

    }
    const pcleaned = cleanName(pname);
    for (let arg in table.schema.out) {
        if (!table.schema.out[arg].isNumber)
            continue;
        if (cleanName(table.schema.getArgCanonical(arg)) === `${pcleaned} ${operation}`)
            return arg;
    }
    return false;
}

function maybeGetIdFilter(filter) {
    for (let atom of iterateFields(filter)) {
        if (atom.name === 'id')
            return atom.value;
    }
    return undefined;
}

function addGetPredicateJoin(table, get_predicate_table, pname, $options) {
    if (coin(0.9, $options.rng))
        return null;
    if (!get_predicate_table.isFilter || !get_predicate_table.table.isInvocation)
        return null;


    const idType = get_predicate_table.schema.getArgType('id');
    if (!idType || !idType.isEntity)
        return null;
    let lhsArg = undefined;
    if (pname) {
        lhsArg = table.schema.getArgument(pname);
        if (!lhsArg)
            return null;
        if (!(lhsArg.type.equals(idType) ||
            (lhsArg.type.isArray && lhsArg.type.elem.equals(idType))))
            return null;

    } else {
        for (let arg of table.schema.iterateArguments()) {
            if (arg.type.equals(idType) ||
                (arg.type.isArray && arg.type.elem.equals(idType))) {
                lhsArg = arg;
                break;
            }
        }
        if (!lhsArg)
            return null;
    }
    if (lhsArg.name === 'id')
        return null;

    const idFilter = maybeGetIdFilter(get_predicate_table.filter);
    if (idFilter) {
        return addFilter(table, new Ast.BooleanExpression.Atom(lhsArg.name,
            lhsArg.type.isArray ? 'contains': '==', idFilter), $options);
    }

    const get_predicate = new Ast.BooleanExpression.External(
        get_predicate_table.table.invocation.selector,
        get_predicate_table.table.invocation.channel,
        get_predicate_table.table.invocation.in_params,
        Ast.BooleanExpression.And([get_predicate_table.filter,
            Ast.BooleanExpression.Atom('id', (lhsArg.type.isArray ? 'in_array' : '=='), new Ast.Value.VarRef(lhsArg.name))]),
        get_predicate_table.table.invocation.schema
    );
    return addFilter(table, get_predicate, $options);
}

function addArrayJoin(lhs, rhs, $options) {
    if (coin(0.9, $options.rng))
        return null;

    if (!lhs.isFilter)
        return null;

    const idType = rhs.schema.getArgType('id');
    if (!idType || !idType.isEntity)
        return null;
    let lhsArg = undefined;
    for (let arg of lhs.schema.iterateArguments()) {
        if (arg.type.equals(idType) ||
            (arg.type.isArray && arg.type.elem.equals(idType))) {
            lhsArg = arg;
            break;
        }
    }
    if (!lhsArg)
        return null;
    if (lhsArg.name === 'id')
        return null;

    const newSchema = mergeSchemas('query', lhs.schema, rhs.schema, null);
    return new Ast.Table.Filter(
        new Ast.Table.Join(lhs, rhs, [], newSchema),
        new Ast.BooleanExpression.Atom('id', (lhsArg.type.isArray ? 'in_array' : '=='), new Ast.Value.VarRef(lhsArg.name)),
        newSchema);
}

module.exports = {
    typeToStringSafe,
    findFunctionNameTable,

    notifyAction,
    builtinSayAction,
    locationGetPredicate,
    timeGetPredicate,

    makeProgram,
    //combineRemoteProgram,
    makePolicy,
    combineStreamCommand,

    checkNotSelfJoinStream,

    betaReduce,
    etaReduceTable,

    replacePlaceholderWithConstant,
    replacePlaceholderWithUndefined,
    tableJoinReplacePlaceholder,
    actionReplaceParamWithTable,
    actionReplaceParamWithStream,
    getDoCommand,
    whenDoRule,
    whenGetStream,

    hasUniqueFilter,
    makeFilter,
    makeAndFilter,
    makeOrFilter,
    makeAggregateFilter,
    makeListExpression,
    makeArgMaxMinTable,
    makeSingleFieldProjection,
    makeMultiFieldProjection,
    makeEdgeFilterStream,
    checkFilter,
    addFilter,
    checkAndAddFitlter,
    hasGetPredicate,
    makeGetPredicate,

    makeExampleFromAction,
    makeExampleFromQuery,

    tableToStream,

    addUnit,

    sayProjectionProgram,

    isQueryProgram,
    isContinuousProgram,
    isCompleteCommand,
    replaceAnyParameterFromContext,
    fillNextSlot,
    addTimerToProgram,
    addFilterToProgram,
    addFilterToPolicy,
    makeMonitor,

    //schema.org specific
    filterTableJoin,
    arrayFilterTableJoin,
    hasConflictParam,

    iterateFilters,
    iterateFields,

    addGetPredicateJoin,
    addArrayJoin
};
