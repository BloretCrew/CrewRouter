'use strict';

/**
 * JSON Schema <-> Gemini Schema conversion.
 *
 * Gemini's classic `parameters` / `responseSchema` fields accept a subset of
 * OpenAPI 3.0 (types are upper-case enums). The newer `parametersJsonSchema` /
 * `responseJsonSchema` fields accept full JSON Schema. We keep simple schemas
 * on the widely supported OpenAPI subset and fall back to JSON Schema whenever
 * the source uses constructs the subset cannot express.
 */

const JSON_SCHEMA_ONLY_KEYS = new Set([
  '$ref', '$defs', 'definitions', 'oneOf', 'allOf', 'not',
  'patternProperties', 'additionalProperties', 'const', 'examples',
  'if', 'then', 'else', 'dependentSchemas', 'unevaluatedProperties'
]);

const STRING_LIMIT_KEYS = ['minLength', 'maxLength'];
const NUMBER_LIMIT_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const ARRAY_LIMIT_KEYS = ['minItems', 'maxItems', 'uniqueItems'];
const OBJECT_LIMIT_KEYS = ['minProperties', 'maxProperties'];

const TYPE_MAP = Object.freeze({
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL'
});

const GEMINI_TYPE_MAP = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null'
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mediaTypeFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || mime.startsWith('text/') || mime.includes('document')) return 'document';
  return 'file';
}

function parseDataUri(value) {
  const text = String(value || '');
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(text);
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', data: match[2] };
}

function toDataUri(mimeType, data) {
  return `data:${mimeType || 'application/octet-stream'};base64,${data || ''}`;
}

function schemaHasJsonOnlyConstructs(schema, seen = new Set()) {
  if (!isPlainObject(schema)) return false;
  if (seen.has(schema)) return false;
  seen.add(schema);
  for (const key of Object.keys(schema)) {
    if (JSON_SCHEMA_ONLY_KEYS.has(key)) return true;
  }
  if (isPlainObject(schema.properties)) {
    for (const value of Object.values(schema.properties)) {
      if (schemaHasJsonOnlyConstructs(value, seen)) return true;
    }
  }
  if (Array.isArray(schema.items) || isPlainObject(schema.items)) {
    if (Array.isArray(schema.items)) return true;
    if (schemaHasJsonOnlyConstructs(schema.items, seen)) return true;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      for (const item of schema[key]) {
        if (schemaHasJsonOnlyConstructs(item, seen)) return true;
      }
    }
  }
  return false;
}

function resolveLocalRef(root, ref) {
  if (!isPlainObject(root) || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = decodeURIComponent(rawPart).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    node = node[part];
  }
  return isPlainObject(node) ? node : null;
}

function inferJsonType(schema) {
  if (!isPlainObject(schema)) return '';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.find(type => type !== 'null') || 'null';
  if (schema.properties || schema.type === 'object') return 'object';
  if (schema.items) return 'array';
  if (Array.isArray(schema.enum)) {
    const first = schema.enum.find(value => value !== null);
    if (typeof first === 'number') return Number.isInteger(first) ? 'integer' : 'number';
    if (typeof first === 'boolean') return 'boolean';
    return 'string';
  }
  return '';
}

function mergeAllOf(schema, root) {
  const merged = { ...schema };
  delete merged.allOf;
  const properties = { ...(isPlainObject(schema.properties) ? schema.properties : {}) };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const part of schema.allOf || []) {
    const resolved = part && part.$ref ? resolveLocalRef(root, part.$ref) : part;
    if (!isPlainObject(resolved)) continue;
    const normalized = mergeAllOf(resolved, root);
    if (isPlainObject(normalized.properties)) Object.assign(properties, normalized.properties);
    for (const name of normalized.required || []) required.add(name);
    for (const [key, value] of Object.entries(normalized)) {
      if (key === 'properties' || key === 'required') continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  if (Object.keys(properties).length) merged.properties = properties;
  if (required.size) merged.required = [...required];
  return merged;
}

/**
 * Convert a JSON/OpenAPI schema to Gemini's OpenAPI subset Schema object.
 * Local refs are inlined; unsupported keywords are dropped.
 */
function toGeminiSchema(schema, root = schema) {
  if (!isPlainObject(schema)) return {};
  if (typeof schema.$ref === 'string') {
    const resolved = resolveLocalRef(root, schema.$ref);
    if (resolved) {
      const merged = toGeminiSchema(resolved, root);
      const { $ref, ...rest } = schema;
      const extra = toGeminiSchema(rest, root);
      return { ...merged, ...extra, properties: { ...(merged.properties || {}), ...(extra.properties || {}) } };
    }
    return {};
  }

  let source = schema;
  if (Array.isArray(schema.allOf) && schema.allOf.length) source = mergeAllOf(schema, root);

  const result = {};
  const jsonType = inferJsonType(source);
  if (jsonType) result.type = TYPE_MAP[jsonType] || 'TYPE_UNSPECIFIED';
  const declaredTypes = Array.isArray(source.type) ? source.type : null;
  if ((declaredTypes && declaredTypes.includes('null')) || source.nullable === true) {
    result.nullable = true;
  }

  for (const key of ['description', 'format', 'title', 'pattern', 'propertyOrdering']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (Array.isArray(source.enum)) result.enum = source.enum.map(value => String(value));
  if (source.default !== undefined) result.default = source.default;

  for (const key of STRING_LIMIT_KEYS.concat(NUMBER_LIMIT_KEYS, ARRAY_LIMIT_KEYS, OBJECT_LIMIT_KEYS)) {
    if (source[key] !== undefined) result[key] = source[key];
  }

  if (isPlainObject(source.properties)) {
    result.properties = {};
    for (const [name, value] of Object.entries(source.properties)) {
      result.properties[name] = toGeminiSchema(value, root);
    }
  }
  if (Array.isArray(source.required) && source.required.length) result.required = [...source.required];
  if (source.items !== undefined) {
    result.items = Array.isArray(source.items) ? toGeminiSchema(source.items[0] || {}, root) : toGeminiSchema(source.items, root);
  }
  const anyOf = Array.isArray(source.anyOf) ? source.anyOf : (Array.isArray(source.oneOf) ? source.oneOf : null);
  if (anyOf && anyOf.length) result.anyOf = anyOf.map(item => toGeminiSchema(item, root));
  return result;
}

/** Convert a Gemini Schema object back to JSON Schema for OpenAI/Anthropic clients. */
function fromGeminiSchema(schema) {
  if (!isPlainObject(schema)) return {};
  const result = {};
  const type = GEMINI_TYPE_MAP[String(schema.type || '').toUpperCase()] || (schema.type ? String(schema.type).toLowerCase() : '');
  if (type) {
    if (schema.nullable === true) result.type = [type, 'null'];
    else result.type = type;
  } else if (schema.nullable === true) {
    result.nullable = true;
  }
  for (const key of ['description', 'format', 'title', 'pattern', 'propertyOrdering',
    'enum', 'default', ...STRING_LIMIT_KEYS, ...NUMBER_LIMIT_KEYS, ...ARRAY_LIMIT_KEYS, ...OBJECT_LIMIT_KEYS]) {
    if (schema[key] !== undefined) result[key] = schema[key];
  }
  if (isPlainObject(schema.properties)) {
    result.properties = {};
    for (const [name, value] of Object.entries(schema.properties)) {
      result.properties[name] = fromGeminiSchema(value);
    }
  }
  if (Array.isArray(schema.required) && schema.required.length) result.required = [...schema.required];
  if (schema.items !== undefined) result.items = fromGeminiSchema(schema.items);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) result.anyOf = schema.anyOf.map(fromGeminiSchema);
  return result;
}

/**
 * Choose between `parameters` (OpenAPI subset) and `parametersJsonSchema`
 * (full JSON Schema) for a function declaration.
 */
function geminiFunctionParameters(inputSchema) {
  if (!isPlainObject(inputSchema) || Object.keys(inputSchema).length === 0) {
    return { parameters: { type: 'OBJECT', properties: {} } };
  }
  if (schemaHasJsonOnlyConstructs(inputSchema)) {
    return { parametersJsonSchema: inputSchema };
  }
  const converted = toGeminiSchema(inputSchema);
  if (!converted.type) converted.type = 'OBJECT';
  if (converted.type === 'OBJECT' && !converted.properties) converted.properties = {};
  return { parameters: converted };
}

function fromGeminiFunctionParameters(declaration) {
  if (!isPlainObject(declaration)) return {};
  if (declaration.parametersJsonSchema && isPlainObject(declaration.parametersJsonSchema)) {
    return declaration.parametersJsonSchema;
  }
  return fromGeminiSchema(declaration.parameters || {});
}

/** Choose the structured-output schema field pair for Gemini. */
function geminiResponseSchema(inputSchema) {
  if (!isPlainObject(inputSchema) || Object.keys(inputSchema).length === 0) return {};
  if (schemaHasJsonOnlyConstructs(inputSchema)) {
    return { responseJsonSchema: inputSchema };
  }
  return { responseSchema: toGeminiSchema(inputSchema) };
}

function fromGeminiResponseSchema(body) {
  const generationConfig = body?.generationConfig || {};
  const schema = generationConfig.responseJsonSchema
    || generationConfig.responseSchema
    || body?.responseJsonSchema
    || body?.responseSchema;
  if (!isPlainObject(schema)) return null;
  if (generationConfig.responseJsonSchema || body?.responseJsonSchema) return schema;
  return fromGeminiSchema(schema);
}

module.exports = {
  TYPE_MAP,
  GEMINI_TYPE_MAP,
  mediaTypeFromMime,
  parseDataUri,
  toDataUri,
  schemaHasJsonOnlyConstructs,
  toGeminiSchema,
  fromGeminiSchema,
  geminiFunctionParameters,
  fromGeminiFunctionParameters,
  geminiResponseSchema,
  fromGeminiResponseSchema
};
