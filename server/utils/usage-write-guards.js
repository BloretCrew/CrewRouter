'use strict';

function timestampRule(column, wallTime = false) {
  const currentTime = wallTime ? "(statement_timestamp() AT TIME ZONE 'Asia/Shanghai')" : 'statement_timestamp()';
  const minimum = wallTime ? "TIMESTAMP '2000-01-01'" : "TIMESTAMPTZ '2000-01-01 00:00:00+00'";
  return { column, required: true, invalid: `NEW.${column} IS NULL OR NOT isfinite(NEW.${column}) OR NEW.${column} < ${minimum} OR NEW.${column} > ${currentTime} + INTERVAL '5 minutes'` };
}

function nonnegativeRule(column, required = false) {
  return { column, required, invalid: `${required ? `NEW.${column} IS NULL OR ` : ''}NEW.${column} < 0 OR NEW.${column}::text IN ('NaN', 'Infinity', '-Infinity')` };
}

function requiredRule(column) {
  return { column, required: true, invalid: `NEW.${quoteIdentifier(column)} IS NULL` };
}

const guards = {
  usage_records: {
    defaultTime: "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')",
    rules: [timestampRule('created_at', true), ...['tokens_used', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'weighted_tokens', 'cost'].map(column => nonnegativeRule(column))],
  },
  usage_message_analysis: {
    defaults: { analyzed_at: "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')" },
    rules: [
      { column: 'usage_id', required: true, invalid: 'NEW.usage_id IS NULL OR NEW.usage_id <= 0' },
      timestampRule('created_at', true), timestampRule('analyzed_at', true), requiredRule('request_source'),
      ...['message_count', 'total_characters', 'total_lines', 'metadata_message_count', 'tokens_used', 'cost'].map(column => nonnegativeRule(column, true)),
      ...['has_workspace_path', 'has_git_status', 'has_project_layout', 'has_environment_context', 'block_counts', 'observed_fields', 'values'].map(requiredRule),
    ],
  },
  request_attempts: {
    defaultTime: 'CURRENT_TIMESTAMP',
    rules: [
      { column: 'logical_request_id', required: true, invalid: 'NEW.logical_request_id IS NULL' },
      timestampRule('started_at'), timestampRule('created_at'),
      requiredRule('streaming'),
      { column: 'status', required: true, invalid: "NEW.status IS NULL OR NEW.status NOT IN ('running', 'success', 'failed', 'cancelled', 'timeout', 'rejected')" },
      { column: 'provider_id', required: true, invalid: "NEW.provider_id IS NULL OR btrim(NEW.provider_id) = ''" },
      { column: 'capture_status', required: true, invalid: "NEW.capture_status IS NULL OR btrim(NEW.capture_status) = ''" },
      { column: 'usage_quality', required: true, invalid: "NEW.usage_quality IS NULL OR NEW.usage_quality NOT IN ('actual', 'estimated', 'unknown')" },
      ...['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'weighted_tokens', 'points'].map(column => nonnegativeRule(column)),
    ],
  },
};

function quoteIdentifier(value) {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function inspectRequiredColumns(db, relation, rules) {
  const names = rules.map(rule => rule.column);
  const columns = (await db.query(`SELECT attname, attnotnull FROM pg_attribute
    WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attname = ANY($2::text[])`, [relation, names])).rows;
  if (columns.length !== names.length) throw new Error(`usage_write_guard_columns_missing:${relation}`);
  const required = new Set(rules.filter(rule => rule.required).map(rule => rule.column));
  const nullable = columns.filter(column => required.has(column.attname) && !column.attnotnull);
  if (!nullable.length) return { restored: [], retainedNullable: [] };
  const counts = (await db.query(`SELECT ${nullable.map(column =>
    `count(*) FILTER (WHERE ${quoteIdentifier(column.attname)} IS NULL)::int AS ${quoteIdentifier(column.attname)}`
  ).join(', ')} FROM ${relation}`)).rows[0];
  return {
    restored: nullable.filter(column => counts[column.attname] === 0).map(column => column.attname),
    retainedNullable: nullable.filter(column => counts[column.attname] > 0).map(column => ({ column: column.attname, nullRows: counts[column.attname] })),
  };
}

async function ensureUsageWriteGuards(db) {
  const tables = await db.query(`
    SELECT namespace.nspname AS schema_name, relation.relname AS table_name
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.oid IN (SELECT to_regclass(name) FROM unnest($1::text[]) AS names(name))
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  `, [Object.keys(guards)]);
  if (tables.rows.length !== Object.keys(guards).length) throw new Error('usage_write_guard_tables_missing');
  const repairs = [];
  for (const table of tables.rows) {
    const guard = guards[table.table_name];
    const schema = quoteIdentifier(table.schema_name);
    const relation = `${schema}.${quoteIdentifier(table.table_name)}`;
    const functionName = `${schema}.${quoteIdentifier(`crewrouter_guard_${table.table_name}_write`)}`;
    const required = await inspectRequiredColumns(db, relation, guard.rules);
    repairs.push({ table: table.table_name, ...required });
    const checks = guard.rules.map(rule => `
      IF (TG_OP = 'INSERT' OR NEW.${quoteIdentifier(rule.column)} IS DISTINCT FROM OLD.${quoteIdentifier(rule.column)})
         AND (${rule.invalid}) THEN
        RAISE EXCEPTION 'invalid_${table.table_name}_${rule.column}' USING ERRCODE = '23514';
      END IF;
    `).join('\n');
    await db.query(`
      ${required.restored.length ? `ALTER TABLE ${relation} ${required.restored.map(column => `ALTER COLUMN ${quoteIdentifier(column)} SET NOT NULL`).join(', ')};` : ''}
      ${guard.defaultTime ? `ALTER TABLE ${relation} ALTER COLUMN created_at SET DEFAULT ${guard.defaultTime};` : ''}
      ${Object.entries(guard.defaults || {}).map(([column, value]) => `ALTER TABLE ${relation} ALTER COLUMN ${quoteIdentifier(column)} SET DEFAULT ${value};`).join('\n')}
      CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
      BEGIN
        ${guard.defaultTime ? `IF TG_OP = 'INSERT' AND NEW.created_at IS NULL THEN NEW.created_at := ${guard.defaultTime}; END IF;` : ''}
        ${checks}
        RETURN NEW;
      END;
      $guard$;
      DROP TRIGGER IF EXISTS crewrouter_usage_write_guard ON ${relation};
      CREATE TRIGGER crewrouter_usage_write_guard BEFORE INSERT OR UPDATE ON ${relation}
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
  }
  return repairs;
}

module.exports = { ensureUsageWriteGuards };
