import type { CompletionResponseFormat } from 'llama.rn';

export type StructuredOutputOptions =
  | { mode: 'text' }
  | { mode: 'json_object' }
  | { mode: 'json_schema'; schema: string }
  | { mode: 'gbnf'; grammar: string };

export const STRUCTURED_OUTPUT_LIMITS = {
  schemaChars: 32_768,
  grammarChars: 32_768,
  schemaDepth: 16,
  schemaNodes: 512,
  resultChars: 262_144,
  resultDepth: 64,
  resultNodes: 32_768,
  collectionLength: 128,
} as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
type Schema = JsonRecord;

export type PreparedStructuredOutput = {
  mode: StructuredOutputOptions['mode'];
  responseFormat?: CompletionResponseFormat;
  grammar?: string;
  /** Validated, reference-expanded schema shared by native formatting and validation. */
  schema?: Schema;
};

export type StructuredOutputValidation = {
  mode: StructuredOutputOptions['mode'];
  status: 'not_applicable' | 'valid' | 'invalid' | 'incomplete';
  error?: 'invalid_json' | 'not_an_object' | 'schema_mismatch' | 'result_limit' | 'interrupted';
};

export class StructuredOutputConfigurationError extends Error {
  readonly code = 'structured_output_configuration';
  constructor(readonly reason: 'size' | 'syntax' | 'dialect' | 'unsupported' | 'shape' | 'reference' | 'complexity') {
    // Never attach schema text, property names, paths or native exception messages.
    super(`Invalid structured output configuration (${reason}).`);
    this.name = 'StructuredOutputConfigurationError';
  }
}

function fail(reason: StructuredOutputConfigurationError['reason']): never {
  throw new StructuredOutputConfigurationError(reason);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ANNOTATIONS = new Set(['$schema', '$defs', 'definitions', 'title', 'description', '$comment']);
const KEYWORDS = new Set([
  ...ANNOTATIONS, '$ref', 'type', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'enum', 'const', 'anyOf',
]);

function assertBoundedJson(value: unknown, maxDepth: number, maxNodes: number): void {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) fail('complexity');
    if (typeof entry === 'number' && !Number.isFinite(entry)) fail('shape');
    if (Array.isArray(entry)) entry.forEach((item) => visit(item, depth + 1));
    else if (isRecord(entry)) Object.values(entry).forEach((item) => visit(item, depth + 1));
  };
  visit(value, 0);
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => jsonEqual(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => owns(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function matchesType(value: JsonValue, type: JsonValue | undefined): boolean {
  switch (type) {
    case undefined: return true;
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    default: return false;
  }
}

function matchesSchema(value: JsonValue, schema: Schema): boolean {
  if (!matchesType(value, schema.type)) return false;
  if (owns(schema, 'const') && !jsonEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(value, entry))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => isRecord(entry) && matchesSchema(value, entry))) return false;
  if (typeof value === 'string') {
    // JSON Schema length counts Unicode code points, not UTF-16 code units.
    const length = Array.from(value).length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (isRecord(schema.items) && !value.every((entry) => matchesSchema(entry, schema.items as Schema))) return false;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required) && !schema.required.every((key) => typeof key === 'string' && owns(value, key))) return false;
    for (const [key, entry] of Object.entries(value)) {
      if (owns(properties, key)) {
        const property = properties[key];
        if (!isRecord(property) || !matchesSchema(entry, property)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (isRecord(schema.additionalProperties) && !matchesSchema(entry, schema.additionalProperties)) return false;
    }
  }
  return true;
}

/**
 * Deliberately restricted Draft 7 subset, checked against rc.3's
 * cpp/common/json-schema-to-grammar.cpp. No generated code or external resolver.
 * Reject constraints that the converter ignores/weakens (e.g. number bounds,
 * patterns, oneOf exclusivity, allOf intersections), rather than claiming support.
 */
export function parseStructuredOutputSchema(source: string): Schema {
  if (typeof source !== 'string' || source.length > STRUCTURED_OUTPUT_LIMITS.schemaChars) fail('size');
  let root: unknown;
  try { root = JSON.parse(source); } catch { fail('syntax'); }
  if (!isRecord(root)) fail('shape');
  assertBoundedJson(root, STRUCTURED_OUTPUT_LIMITS.schemaDepth, STRUCTURED_OUTPUT_LIMITS.schemaNodes * 8);
  const rootSchema = root;
  let visited = 0;
  const resolve = (value: JsonValue, depth: number, refs: ReadonlySet<string>): Schema => {
    if (++visited > STRUCTURED_OUTPUT_LIMITS.schemaNodes || depth > STRUCTURED_OUTPUT_LIMITS.schemaDepth) fail('complexity');
    if (!isRecord(value)) fail('shape');
    for (const key of Object.keys(value)) if (!KEYWORDS.has(key)) fail('unsupported');
    if (value.$schema !== undefined && value.$schema !== 'http://json-schema.org/draft-07/schema#'
      && value.$schema !== 'https://json-schema.org/draft-07/schema#') fail('dialect');
    for (const key of ['title', 'description', '$comment']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') fail('shape');
    }
    for (const key of ['$defs', 'definitions']) {
      if (value[key] !== undefined && !isRecord(value[key])) fail('shape');
    }
    const semanticKeys = Object.keys(value).filter((key) => !ANNOTATIONS.has(key));
    if (value.$ref !== undefined) {
      if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/') || refs.has(value.$ref)
        || semanticKeys.length !== 1) fail('reference');
      const reference = value.$ref;
      let target: JsonValue = rootSchema;
      for (const encoded of reference.slice(2).split('/')) {
        if (/~(?:[^01]|$)/u.test(encoded)) fail('reference');
        const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
        if (!isRecord(target) || !owns(target, key)) fail('reference');
        target = target[key];
      }
      return resolve(target, depth + 1, new Set([...refs, reference]));
    }
    if (value.type !== undefined && (typeof value.type !== 'string' || !TYPES.has(value.type))) fail('shape');
    const result: Schema = {};
    if (value.type !== undefined) result.type = value.type;
    // Remove annotations/definitions after checking them: native never sees refs,
    // unknown dialect keywords, private labels or unused schema declarations.
    if (owns(value, 'const') || value.enum !== undefined) {
      if (semanticKeys.some((key) => !['type', 'const', 'enum'].includes(key))
        || (owns(value, 'const') && owns(value, 'enum'))) fail('unsupported');
      if (value.enum !== undefined) {
        if (!Array.isArray(value.enum) || value.enum.length === 0
          || value.enum.length > STRUCTURED_OUTPUT_LIMITS.collectionLength) fail('shape');
        if (!value.enum.every((entry) => matchesType(entry, value.type))) fail('shape');
        result.enum = value.enum;
      } else {
        if (!matchesType(value.const, value.type)) fail('shape');
        result.const = value.const;
      }
      return result;
    }
    if (value.anyOf !== undefined) {
      if (semanticKeys.length !== 1 || !Array.isArray(value.anyOf) || value.anyOf.length === 0
        || value.anyOf.length > 16) fail('shape');
      result.anyOf = value.anyOf.map((entry) => resolve(entry, depth + 1, refs));
      return result;
    }
    const typedKeywords: Record<string, string[]> = {
      object: ['properties', 'required', 'additionalProperties'],
      array: ['items', 'minItems', 'maxItems'],
      string: ['minLength', 'maxLength'],
      integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
    };
    for (const [type, keys] of Object.entries(typedKeywords)) {
      if (keys.some((key) => value[key] !== undefined) && value.type !== type) fail('unsupported');
    }
    if (value.type === 'object') {
      if (value.properties !== undefined && !isRecord(value.properties)) fail('shape');
      const entries = Object.entries(value.properties ?? {});
      if (entries.length > STRUCTURED_OUTPUT_LIMITS.collectionLength) fail('complexity');
      result.properties = Object.fromEntries(entries.map(([key, entry]) => [key, resolve(entry, depth + 1, refs)]));
      if (value.required !== undefined) {
        if (!Array.isArray(value.required) || value.required.length > STRUCTURED_OUTPUT_LIMITS.collectionLength
          || value.required.some((key) => typeof key !== 'string' || !owns(result.properties as Schema, key))
          || new Set(value.required).size !== value.required.length) fail('shape');
        result.required = [...value.required];
      }
      // rc.3 defaults missing additionalProperties to false in object grammar.
      // Make standard JSON Schema's true default explicit on the native side.
      result.additionalProperties = value.additionalProperties === undefined ? true
        : typeof value.additionalProperties === 'boolean' ? value.additionalProperties
          : resolve(value.additionalProperties, depth + 1, refs);
    }
    if (value.type === 'array') result.items = resolve(value.items ?? {}, depth + 1, refs);
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
      const bound = value[key];
      if (bound !== undefined) {
        if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 0 || bound > 4096) fail('shape');
        result[key] = bound;
      }
    }
    for (const [minKey, maxKey] of [['minItems', 'maxItems'], ['minLength', 'maxLength']]) {
      if (typeof result[minKey] === 'number' && typeof result[maxKey] === 'number'
        && result[minKey] > result[maxKey]) fail('shape');
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      const bound = value[key];
      if (bound !== undefined) {
        if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || Math.abs(bound) > 2_147_483_646) fail('shape');
        result[key] = bound;
      }
    }
    if ((value.minimum !== undefined && value.exclusiveMinimum !== undefined)
      || (value.maximum !== undefined && value.exclusiveMaximum !== undefined)) fail('unsupported');
    const lower = typeof value.minimum === 'number' ? value.minimum
      : typeof value.exclusiveMinimum === 'number' ? value.exclusiveMinimum + 1 : undefined;
    const upper = typeof value.maximum === 'number' ? value.maximum
      : typeof value.exclusiveMaximum === 'number' ? value.exclusiveMaximum - 1 : undefined;
    if (lower !== undefined && upper !== undefined && lower > upper) fail('shape');
    // rc.3 treats an entirely empty schema as object; a harmless description
    // chooses its generic JSON value rule, preserving {} semantics instead.
    if (Object.keys(result).length === 0) result.description = '';
    return result;
  };
  // Validate unused definitions too, so an external ref cannot hide there.
  const inspectDefinitions = (value: JsonValue, depth: number): void => {
    if (depth > STRUCTURED_OUTPUT_LIMITS.schemaDepth) fail('complexity');
    if (isRecord(value)) {
      for (const key of ['$defs', 'definitions']) {
        const definitions = value[key];
        if (definitions !== undefined) {
          if (!isRecord(definitions)) fail('shape');
          for (const entry of Object.values(definitions)) {
            resolve(entry, depth + 1, new Set());
            inspectDefinitions(entry, depth + 1);
          }
        }
      }
      // Only schema positions are schemas. Literal enum/const data can itself
      // contain properties named $defs/$ref without becoming a resolver input.
      if (isRecord(value.properties)) {
        for (const entry of Object.values(value.properties)) inspectDefinitions(entry, depth + 1);
      }
      if (value.items !== undefined) inspectDefinitions(value.items, depth + 1);
      if (value.additionalProperties !== undefined) inspectDefinitions(value.additionalProperties, depth + 1);
      if (Array.isArray(value.anyOf)) value.anyOf.forEach((entry) => inspectDefinitions(entry, depth + 1));
    }
  };
  inspectDefinitions(rootSchema, 0);
  return resolve(rootSchema, 0, new Set());
}

export function prepareStructuredOutput(options: StructuredOutputOptions = { mode: 'text' }): PreparedStructuredOutput {
  switch (options.mode) {
    case 'text': return { mode: 'text' };
    case 'json_object': return {
      mode: 'json_object', responseFormat: { type: 'json_object', schema: { type: 'object', additionalProperties: true } },
    };
    case 'json_schema': {
      const schema = parseStructuredOutputSchema(options.schema);
      return { mode: 'json_schema', schema, responseFormat: { type: 'json_schema', json_schema: { strict: true, schema } } };
    }
    case 'gbnf':
      if (typeof options.grammar !== 'string' || options.grammar.length > STRUCTURED_OUTPUT_LIMITS.grammarChars) fail('size');
      if (!options.grammar.trim()) fail('syntax');
      // Match the pinned native backend selector, not text inside GBNF terminals.
      if (options.grammar.startsWith('%llguidance')) fail('unsupported');
      return { mode: 'gbnf', grammar: options.grammar };
    default: return fail('shape');
  }
}

/** Call once after native settles; never parse unfinished streaming JSON. */
export function validateStructuredOutputResult(
  prepared: PreparedStructuredOutput,
  result: {
    /** Parsed user content only: callers must exclude reasoning and tool fields. */
    content: string;
    interrupted?: boolean;
    stoppedLimit?: boolean | number;
    truncated?: boolean;
    contextFull?: boolean;
  },
): StructuredOutputValidation {
  const { mode } = prepared;
  if (mode === 'text' || mode === 'gbnf') return { mode, status: 'not_applicable' };
  if (result.interrupted || result.stoppedLimit || result.truncated || result.contextFull) {
    return { mode, status: 'incomplete', error: 'interrupted' };
  }
  if (result.content.length > STRUCTURED_OUTPUT_LIMITS.resultChars) return { mode, status: 'invalid', error: 'result_limit' };
  let value: JsonValue;
  try { value = JSON.parse(result.content); }
  catch { return { mode, status: 'invalid', error: 'invalid_json' }; }
  try { assertBoundedJson(value, STRUCTURED_OUTPUT_LIMITS.resultDepth, STRUCTURED_OUTPUT_LIMITS.resultNodes); }
  catch { return { mode, status: 'invalid', error: 'result_limit' }; }
  if (mode === 'json_object' && !isRecord(value)) return { mode, status: 'invalid', error: 'not_an_object' };
  if (mode === 'json_schema' && (!prepared.schema || !matchesSchema(value, prepared.schema))) {
    return { mode, status: 'invalid', error: 'schema_mismatch' };
  }
  return { mode, status: 'valid' };
}
