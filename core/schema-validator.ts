const fs = require('node:fs');
const path = require('node:path');

type JsonSchema = Record<string, unknown> & {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  items?: JsonSchema;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

type ValidationError = {
  code: string;
  path: string;
  message: string;
};

type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  message: string;
};

/**
 * Error thrown when a manifest or generated artifact does not satisfy its schema.
 */
class SchemaValidationError extends Error {
  label: string;
  errors: ValidationError[];

  /**
   * @param {string} label
   * @param {{code: string, path: string, message: string}[]} errors
   */
  constructor(label: string, errors: ValidationError[]) {
    super(formatValidationErrorMessage(label, errors));
    this.name = 'SchemaValidationError';
    this.label = label;
    this.errors = errors;
  }
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Loads a schema from the repo-local `schemas` directory.
 *
 * @param {string} relativePath
 * @returns {Record<string, unknown>}
 */
function loadSchema(relativePath: string): JsonSchema {
  const sourcePath = path.join(__dirname, '..', 'schemas', relativePath);
  const compiledPath = path.join(__dirname, '..', '..', 'schemas', relativePath);
  const schemaPath = fs.existsSync(sourcePath) ? sourcePath : compiledPath;
  return readJson(schemaPath) as JsonSchema;
}

const SCHEMAS = {
  comparison: loadSchema('comparison.schema.json'),
  health: loadSchema('health.schema.json'),
  scenario: loadSchema('scenario.schema.json'),
  runnerCapabilities: loadSchema('runner-capabilities.schema.json'),
  verdict: loadSchema('verdict.schema.json'),
};

/**
 * Formats a validation path as a JSONPath-like string.
 *
 * @param {(string | number)[]} pathSegments
 * @returns {string}
 */
function formatPath(pathSegments: Array<string | number>): string {
  if (pathSegments.length === 0) {
    return '$';
  }

  return pathSegments.reduce<string>((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[${segment}]`;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      return `${result}.${segment}`;
    }

    return `${result}[${JSON.stringify(segment)}]`;
  }, '$');
}

/**
 * Stringifies object values with stable key ordering for `uniqueItems` checks.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stableStringify(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const source = value as Record<string, unknown>;
        result[key] = source[key];
        return result;
      }, {}),
  );
}

/**
 * Formats enum values for validation error messages.
 *
 * @param {unknown[]} values
 * @returns {string}
 */
function describeAllowedValues(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

/**
 * Resolves local JSON Schema references such as `#/$defs/capability`.
 *
 * @param {Record<string, unknown>} rootSchema
 * @param {string} ref
 * @returns {Record<string, unknown>}
 */
function resolveLocalRef(rootSchema: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local schema refs are supported: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!current || typeof current !== 'object' || !(key in current)) {
        throw new Error(`Schema ref could not be resolved: ${ref}`);
      }
      return (current as Record<string, unknown>)[key];
    }, rootSchema) as JsonSchema;
}

/**
 * Checks a JavaScript value against one JSON Schema primitive type.
 *
 * @param {unknown} value
 * @param {string} type
 * @returns {boolean}
 */
function isType(value: unknown, type: string): boolean {
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

/**
 * Validates the `type` keyword and records one error on mismatch.
 *
 * @param {{value: unknown, expectedType: string | string[], pathSegments: (string | number)[], errors: {code: string, path: string, message: string}[]}} options
 * @returns {boolean}
 */
function validateType({
  value,
  expectedType,
  pathSegments,
  errors,
}: {
  value: unknown;
  expectedType: string | string[];
  pathSegments: Array<string | number>;
  errors: ValidationError[];
}): boolean {
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

/**
 * Validates the JSON Schema subset used by this package's public contracts.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @param {Record<string, unknown>} rootSchema
 * @param {(string | number)[]} [pathSegments]
 * @param {{code: string, path: string, message: string}[]} [errors]
 * @returns {{code: string, path: string, message: string}[]}
 */
function validateSchema(
  value: unknown,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  pathSegments: Array<string | number> = [],
  errors: ValidationError[] = [],
): ValidationError[] {
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
    validateObject(value as Record<string, unknown>, schema, rootSchema, pathSegments, errors);
  }

  return errors;
}

/**
 * Validates array-specific schema keywords.
 *
 * @param {unknown[]} value
 * @param {Record<string, unknown>} schema
 * @param {Record<string, unknown>} rootSchema
 * @param {(string | number)[]} pathSegments
 * @param {{code: string, path: string, message: string}[]} errors
 * @returns {void}
 */
function validateArray(
  value: unknown[],
  schema: JsonSchema,
  rootSchema: JsonSchema,
  pathSegments: Array<string | number>,
  errors: ValidationError[],
): void {
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
    const itemSchema = schema.items;
    value.forEach((item, index) => validateSchema(item, itemSchema, rootSchema, [...pathSegments, index], errors));
  }
}

/**
 * Validates object-specific schema keywords.
 *
 * @param {Record<string, unknown>} value
 * @param {Record<string, unknown>} schema
 * @param {Record<string, unknown>} rootSchema
 * @param {(string | number)[]} pathSegments
 * @param {{code: string, path: string, message: string}[]} errors
 * @returns {void}
 */
function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  pathSegments: Array<string | number>,
  errors: ValidationError[],
): void {
  if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
    errors.push({
      code: 'too_few_properties',
      path: formatPath(pathSegments),
      message: `Expected at least ${schema.minProperties} properties.`,
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

/**
 * Validates a value against a schema and returns structured errors instead of throwing.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @param {string} [label]
 * @returns {{valid: boolean, errors: {code: string, path: string, message: string}[], message: string}}
 */
function validateJson(value: unknown, schema: JsonSchema, label = 'JSON document'): ValidationResult {
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

/**
 * Validates a value against a schema, throwing `SchemaValidationError` on failure.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @param {string} label
 * @returns {unknown}
 */
function assertValidJson(value: unknown, schema: JsonSchema, label: string): unknown {
  const result = validateJson(value, schema, label);
  if (!result.valid) {
    throw new SchemaValidationError(label, result.errors);
  }

  return value;
}

/**
 * Formats schema errors as a CLI-readable message.
 *
 * @param {string} label
 * @param {{path: string, message: string}[]} errors
 * @returns {string}
 */
function formatValidationErrorMessage(label: string, errors: Array<Pick<ValidationError, 'path' | 'message'>>): string {
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
