'use strict';

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'secret']);

function validateConfigSchema(schema) {
  if (schema === undefined) return null;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'configSchema 必须是对象';
  for (const [key, field] of Object.entries(schema)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) return `configSchema 字段名不合法: ${key}`;
    if (!field || typeof field !== 'object' || Array.isArray(field)) return `configSchema.${key} 必须是对象`;
    if (!SUPPORTED_TYPES.has(field.type)) return `configSchema.${key}.type 不受支持`;
    for (const textKey of ['label', 'description']) {
      if (field[textKey] !== undefined && (typeof field[textKey] !== 'string' || field[textKey].length > 500)) return `configSchema.${key}.${textKey} 必须是最多 500 字符的字符串`;
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') return `configSchema.${key}.required 必须是布尔值`;
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100)) return `configSchema.${key}.options 必须是 1–100 项的数组`;
    if ((field.type === 'boolean' || field.type === 'secret') && field.options !== undefined) return `configSchema.${key} 不支持 options`;
    if (field.type === 'secret' && field.default !== undefined) return `configSchema.${key} secret 字段不能设置默认值`;
    for (const bound of ['min', 'max']) if (field[bound] !== undefined && (typeof field[bound] !== 'number' || !Number.isFinite(field[bound]))) return `configSchema.${key}.${bound} 必须是有限数字`;
    if (field.type === 'string' || field.type === 'secret') {
      if (field.min !== undefined && field.min < 0) return `configSchema.${key}.min 长度不能为负数`;
      if (field.max !== undefined && field.max < 0) return `configSchema.${key}.max 长度不能为负数`;
    } else if (field.type === 'number' || field.type === 'integer') {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) return `configSchema.${key}.min 不能大于 max`;
      if (field.options?.some(value => typeof value !== 'number')) return `configSchema.${key}.options 必须与数值类型一致`;
    } else if (field.options?.some(value => typeof value !== 'string')) return `configSchema.${key}.options 必须与字符串类型一致`;
    if (field.default !== undefined) {
      const error = validateValue(key, field.default, field);
      if (error) return `configSchema.${key}.default ${error}`;
    }
  }
  return null;
}

function validateValue(key, value, field) {
  if (value === undefined || value === null) return field.required ? `${key} 为必填项` : null;
  const expectedType = field.type === 'secret' ? 'string' : field.type;
  if (typeof value !== expectedType && !(field.type === 'integer' && Number.isInteger(value))) return `${key} 类型必须是 ${expectedType}`;
  if (field.type === 'number' && !Number.isFinite(value)) return `${key} 必须是有限数字`;
  if (field.type === 'integer' && !Number.isSafeInteger(value)) return `${key} 必须是安全整数`;
  if (field.type === 'string' || field.type === 'secret') {
    if (field.min !== undefined && value.length < field.min) return `${key} 长度不能小于 ${field.min}`;
    if (field.max !== undefined && value.length > field.max) return `${key} 长度不能大于 ${field.max}`;
  } else if (field.type === 'number' || field.type === 'integer') {
    if (field.min !== undefined && value < field.min) return `${key} 不能小于 ${field.min}`;
    if (field.max !== undefined && value > field.max) return `${key} 不能大于 ${field.max}`;
  }
  if (Array.isArray(field.options) && !field.options.some(option => option === value)) return `${key} 必须是允许的选项之一`;
  return null;
}

function validateConfig(config, schema) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'config 必须是对象';
  if (!schema) return null;
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(schema, key)) return `不支持的配置项: ${key}`;
  }
  for (const [key, field] of Object.entries(schema)) {
    const error = validateValue(key, config[key], field);
    if (error) return error;
  }
  return null;
}

function applyDefaults(config, schema) {
  const output = { ...(config || {}) };
  for (const [key, field] of Object.entries(schema || {})) {
    if (!Object.hasOwn(output, key) && field.default !== undefined) output[key] = field.default;
  }
  return output;
}

function preserveSecrets(config, existingConfig, schema) {
  const output = { ...(config || {}) };
  const existing = existingConfig || {};
  for (const [key, field] of Object.entries(schema || {})) {
    if (field.type !== 'secret') continue;
    const hasExisting = Object.prototype.hasOwnProperty.call(existing, key);
    const supplied = Object.prototype.hasOwnProperty.call(output, key) ? output[key] : undefined;
    if (hasExisting && (supplied === undefined || supplied === null || supplied === '')) output[key] = existing[key];
  }
  return output;
}

function redactConfig(config, schema) {
  const visible = { ...(config || {}) };
  const configured = {};
  for (const [key, field] of Object.entries(schema || {})) {
    if (field.type !== 'secret') continue;
    configured[key] = typeof visible[key] === 'string' && visible[key].length > 0;
    delete visible[key];
  }
  return { config: visible, configSecrets: configured };
}

module.exports = { validateConfigSchema, validateConfig, applyDefaults, preserveSecrets, redactConfig };
