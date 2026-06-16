const fs = require('node:fs');
const path = require('node:path');

class SchemaValidationError extends Error {
  constructor(label, errors) {
    super(formatValidationErrorMessage(label, errors));
    this.name = 'SchemaValidationError';
    this.label = label;
    this.errors = errors;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadSchema(relativePath) {
  return readJson(path.join(__dirname, '..', 'schemas', relativePath));
}

const SCHEMAS = {
  health: loadSchema('health.schema.json'),
  scenario: loadSchema('scenario.schema.json'),
  runnerCapabilities: loadSchema('runner-capabilities.schema.json'),
  verdict: loadSchema('verdict.schema.json'),
};

function formatPath(pathSegments) {
  if (pathSegments.length === 0) {
    return '$';
  }

  return pathSegments.reduce((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[${segment}]`;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      return `${result}.${segment}`;
    }

    return `${result}[${JSON.stringify(segment)}]`;
  }, '$');
}

function stableStringify(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = value[key];
        return result;
      }, {}),
  );
}

function describeAllowedValues(values) {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

function resolveLocalRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local schema refs are supported: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .reduce((current, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!current || typeof current !== 'object' || !(key in current)) {
        throw new Error(`Schema ref could not be resolved: ${ref}`);
      }
      return current[key];
    }, rootSchema);
}

function isType(value, type) {
  if (type === 'array') {
    return Array.isArray(value);
  }

  if (type === 'object') {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  if (type === 'integer') {
    return Number.isInteger(value);
  }

  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  return typeof value === type;
}

function validateType({ value, expectedType, pathSegments, errors }) {
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!expectedTypes.some((type) => isType(value, type))) {
    errors.push({
      code: 'invalid_type',
      path: formatPath(pathSegments),
      message: `Expected ${expectedTypes.join(' or ')}.`,
    });
    return false;
  }

  return true;
}

function validateSchema(value, schema, rootSchema, pathSegments = [], errors = []) {
  if (!schema || typeof schema !== 'object') {
    return errors;
  }

  if (schema.$ref) {
    validateSchema(value, resolveLocalRef(rootSchema, schema.$ref), rootSchema, pathSegments, errors);
  }

  if (schema.type && !validateType({ value, expectedType: schema.type, pathSegments, errors })) {
    return errors;
  }

  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push({
      code: 'invalid_enum',
      path: formatPath(pathSegments),
      message: `Expected one of ${describeAllowedValues(schema.enum)}.`,
    });
  }

  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    const regex = new RegExp(schema.pattern, 'u');
    if (!regex.test(value)) {
      errors.push({
        code: 'invalid_pattern',
        path: formatPath(pathSegments),
        message: `Expected value to match ${schema.pattern}.`,
      });
    }
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push({
      code: 'below_minimum',
      path: formatPath(pathSegments),
      message: `Expected value to be >= ${schema.minimum}.`,
    });
  }

  if (Array.isArray(value)) {
    validateArray(value, schema, rootSchema, pathSegments, errors);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    validateObject(value, schema, rootSchema, pathSegments, errors);
  }

  return errors;
}

function validateArray(value, schema, rootSchema, pathSegments, errors) {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push({
      code: 'too_few_items',
      path: formatPath(pathSegments),
      message: `Expected at least ${schema.minItems} item(s).`,
    });
  }

  if (schema.uniqueItems === true) {
    const seen = new Set();
    for (const item of value) {
      const key = stableStringify(item);
      if (seen.has(key)) {
        errors.push({
          code: 'duplicate_item',
          path: formatPath(pathSegments),
          message: 'Expected array items to be unique.',
        });
        break;
      }
      seen.add(key);
    }
  }

  if (schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, rootSchema, [...pathSegments, index], errors));
  }
}

function validateObject(value, schema, rootSchema, pathSegments, errors) {
  if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
    errors.push({
      code: 'too_few_properties',
      path: formatPath(pathSegments),
      message: `Expected at least ${schema.minProperties} propertie(s).`,
    });
  }

  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in value)) {
      errors.push({
        code: 'missing_required_property',
        path: formatPath([...pathSegments, requiredKey]),
        message: `Missing required property \`${requiredKey}\`.`,
      });
    }
  }

  const definedProperties = schema.properties ?? {};
  for (const [key, propertySchema] of Object.entries(definedProperties)) {
    if (key in value) {
      validateSchema(value[key], propertySchema, rootSchema, [...pathSegments, key], errors);
    }
  }

  for (const key of Object.keys(value)) {
    if (key in definedProperties) {
      continue;
    }

    if (schema.additionalProperties === false) {
      errors.push({
        code: 'additional_property',
        path: formatPath([...pathSegments, key]),
        message: `Unexpected property \`${key}\`.`,
      });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validateSchema(value[key], schema.additionalProperties, rootSchema, [...pathSegments, key], errors);
    }
  }
}

function validateJson(value, schema, label = 'JSON document') {
  const errors = validateSchema(value, schema, schema);
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      message: formatValidationErrorMessage(label, errors),
    };
  }

  return {
    valid: true,
    errors: [],
    message: '',
  };
}

function assertValidJson(value, schema, label) {
  const result = validateJson(value, schema, label);
  if (!result.valid) {
    throw new SchemaValidationError(label, result.errors);
  }

  return value;
}

function formatValidationErrorMessage(label, errors) {
  return [
    `${label} failed schema validation:`,
    ...errors.map((error) => `- ${error.path}: ${error.message}`),
  ].join('\n');
}

module.exports = {
  SCHEMAS,
  SchemaValidationError,
  assertValidJson,
  formatValidationErrorMessage,
  validateJson,
};
