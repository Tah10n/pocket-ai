import type { CompletionParams } from 'llama.rn';
import {
  parseStructuredOutputSchema, prepareStructuredOutput, StructuredOutputConfigurationError,
  STRUCTURED_OUTPUT_LIMITS, validateStructuredOutputResult,
} from '../../src/utils/structuredOutput';

const prepare = (schema: object) => prepareStructuredOutput({ mode: 'json_schema', schema: JSON.stringify(schema) });
const check = (schema: object, value: unknown) => validateStructuredOutputResult(prepare(schema), { content: JSON.stringify(value) });

describe('structured output schema subset', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { status: { type: 'string', enum: ['yes', 'no'] }, count: { type: 'integer', minimum: 0, maximum: 5 } },
    required: ['status', 'count'], additionalProperties: false,
  };

  it('maps real response_format declarations and independently validates required, enum and integer bounds', () => {
    const prepared = prepare(schema);
    const params = { response_format: prepared.responseFormat } satisfies CompletionParams;
    expect(params.response_format?.type).toBe('json_schema');
    expect(check(schema, { status: 'yes', count: 0 }).status).toBe('valid');
    for (const value of [{ status: 'maybe', count: 0 }, { status: 'no' }, { status: 'yes', count: 6 },
      { status: 'yes', count: 1.5 }, { status: 'yes', count: 1, extra: false }]) {
      expect(check(schema, value)).toMatchObject({ status: 'invalid', error: 'schema_mismatch' });
    }
  });

  it('preserves standard additional properties and empty schema semantics in native conversion', () => {
    const prepared = prepare({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(prepared.schema?.additionalProperties).toBe(true);
    expect(validateStructuredOutputResult(prepared, { content: '{"extra": 0}' }).status).toBe('valid');
    expect(parseStructuredOutputSchema('{}')).toEqual({ description: '' });
    for (const value of [null, false, 0, [], {}]) expect(check({}, value).status).toBe('valid');
  });

  it('expands local refs including escaped pointer components without a native resolver', () => {
    const prepared = prepare({
      definitions: { 'a/b~c': { type: 'integer', minimum: 0 } },
      type: 'object', properties: { value: { $ref: '#/definitions/a~1b~0c' } }, required: ['value'],
    });
    expect(prepared.schema?.properties).toEqual({ value: { type: 'integer', minimum: 0 } });
    expect(JSON.stringify(prepared.schema)).not.toContain('$ref');
    expect(validateStructuredOutputResult(prepared, { content: '{"value":0}' }).status).toBe('valid');
    expect(validateStructuredOutputResult(prepared, { content: '{"value":-1}' }).status).toBe('invalid');
  });

  it.each(['https://example.invalid/schema', 'file:///private/schema', '#', '#/missing', '#/definitions/a~2b'])
  ('rejects unsupported or unresolved reference %s without I/O', ($ref) => {
    expect(() => prepare({ $ref })).toThrow(StructuredOutputConfigurationError);
  });

  it('rejects recursive and exponentially expanded local references within a bounded budget', () => {
    expect(() => prepare({ definitions: { self: { $ref: '#/definitions/self' } }, $ref: '#/definitions/self' })).toThrow(StructuredOutputConfigurationError);
    const definitions: Record<string, object> = { d0: { type: 'string' } };
    for (let i = 1; i < 12; i++) definitions[`d${i}`] = { anyOf: [{ $ref: `#/definitions/d${i - 1}` }, { $ref: `#/definitions/d${i - 1}` }] };
    expect(() => prepare({ definitions, $ref: '#/definitions/d11' })).toThrow(StructuredOutputConfigurationError);
  });

  it.each([
    { $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { type: ['string', 'null'] }, { type: 'string', pattern: '^.*$' }, { type: 'string', format: 'email' },
    { type: 'number', minimum: 0 }, { oneOf: [{ type: 'string' }] }, { allOf: [{ type: 'object' }] },
    { type: 'array', items: false }, { type: 'array', uniqueItems: true }, { type: 'integer', multipleOf: 2 },
    { type: 'object', required: ['undeclared'] }, { type: 'string', minLength: 5, maxLength: 2 },
    { type: 'integer', minimum: 0, exclusiveMinimum: 0 }, { type: 'integer', minimum: 5, maximum: 2 },
    { type: 'string', enum: ['x'], minLength: 2 }, { type: 'integer', const: 'wrong' },
    { anyOf: [{ type: 'string' }], type: 'string' }, { type: 'string', enum: [] },
    { $ref: '#/definitions/x', type: 'string', definitions: { x: { type: 'number' } } },
    { definitions: { unused: { $ref: 'https://example.invalid/schema' } }, type: 'object' },
  ])('rejects unsupported or incompatible schema %# before native', (input) => {
    expect(() => prepare(input)).toThrow(StructuredOutputConfigurationError);
  });

  it('supports bounded homogeneous arrays, Unicode string lengths, const and anyOf', () => {
    expect(check({ type: 'array', items: { type: 'boolean' }, minItems: 0, maxItems: 1 }, []).status).toBe('valid');
    expect(check({ type: 'array', items: { type: 'boolean' } }, [0]).status).toBe('invalid');
    expect(check({ type: 'string', minLength: 1, maxLength: 1 }, '😀').status).toBe('valid');
    expect(check({ const: { a: 0, b: [] } }, { b: [], a: 0 }).status).toBe('valid');
    expect(check({ anyOf: [{ type: 'null' }, { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 2 }] }, 1).status).toBe('valid');
    expect(check({ anyOf: [{ type: 'null' }, { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 2 }] }, 2).status).toBe('invalid');
  });

  it('checks additional property schemas and prototype-like property names as data', () => {
    expect(check({ type: 'object', additionalProperties: { type: 'boolean' } }, { arbitrary: false }).status).toBe('valid');
    expect(check({ type: 'object', additionalProperties: { type: 'boolean' } }, { arbitrary: 0 }).status).toBe('invalid');
    const prepared = prepareStructuredOutput({ mode: 'json_schema', schema: '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}' });
    expect(validateStructuredOutputResult(prepared, { content: '{"__proto__":"data"}' }).status).toBe('valid');
    expect(validateStructuredOutputResult(prepared, { content: '{}' }).status).toBe('invalid');
  });

  it('bounds schema size/depth and emits no source or parser errors in exceptions', () => {
    expect(() => parseStructuredOutputSchema(' '.repeat(STRUCTURED_OUTPUT_LIMITS.schemaChars + 1))).toThrow(StructuredOutputConfigurationError);
    let nested: object = { type: 'string' };
    for (let i = 0; i < 20; i++) nested = { type: 'array', items: nested };
    expect(() => prepare(nested)).toThrow(StructuredOutputConfigurationError);
    try { parseStructuredOutputSchema('{"private prompt, schema and path"'); }
    catch (error) { expect(String(error)).toBe('StructuredOutputConfigurationError: Invalid structured output configuration (syntax).'); }
  });
});

describe('final output validation', () => {
  it('treats schema-looking keys in constant data as literal output', () => {
    const literal = { $defs: { value: 1 }, $ref: 'https://example.invalid/literal' };
    const prepared = prepareStructuredOutput({ mode: 'json_schema', schema: JSON.stringify({ const: literal }) });
    expect(validateStructuredOutputResult(prepared, { content: JSON.stringify(literal) }).status).toBe('valid');
  });
  const object = prepareStructuredOutput({ mode: 'json_object' });

  it('requires a JSON object, never repairs fences or reasoning into JSON', () => {
    expect(validateStructuredOutputResult(object, { content: ' {"ok": false} \n' }).status).toBe('valid');
    for (const content of ['null', '[]', 'false', '0', '"text"']) expect(validateStructuredOutputResult(object, { content }).error).toBe('not_an_object');
    for (const content of ['```json\n{}\n```', '<think>reasoning</think>{}', '{"unfinished":', '{} trailing']) {
      expect(validateStructuredOutputResult(object, { content }).error).toBe('invalid_json');
    }
  });

  it.each([{ interrupted: true }, { stoppedLimit: true }, { stoppedLimit: 1 }, { truncated: true }, { contextFull: true }])
  ('never labels cancelled/token-limited/truncated output successful even when parseable: %o', (flags) => {
    expect(validateStructuredOutputResult(object, { content: '{}', ...flags })).toMatchObject({ status: 'incomplete' });
    expect(validateStructuredOutputResult(object, { content: '{', ...flags })).toMatchObject({ status: 'incomplete' });
  });

  it('preserves meaningful false/0 completion flags and bounds final result size/depth', () => {
    expect(validateStructuredOutputResult(object, { content: '{}', stoppedLimit: 0, interrupted: false, truncated: false, contextFull: false }).status).toBe('valid');
    expect(validateStructuredOutputResult(object, { content: ' '.repeat(STRUCTURED_OUTPUT_LIMITS.resultChars + 1) }).error).toBe('result_limit');
    expect(validateStructuredOutputResult(object, { content: '['.repeat(80) + '0' + ']'.repeat(80) }).error).toBe('result_limit');
  });

  it('keeps GBNF exact and leaves native grammar validation distinct from JSON validation', () => {
    const grammar = 'root ::= "yes"\n';
    const prepared = prepareStructuredOutput({ mode: 'gbnf', grammar });
    expect(prepared.grammar).toBe(grammar);
    expect(prepared.responseFormat).toBeUndefined();
    expect(validateStructuredOutputResult(prepared, { content: 'yes' }).status).toBe('not_applicable');
    expect(() => prepareStructuredOutput({ mode: 'gbnf', grammar: '  ' })).toThrow(StructuredOutputConfigurationError);
    expect(validateStructuredOutputResult(prepareStructuredOutput(), { content: 'plain text' }).status).toBe('not_applicable');
  });

  it('does not retain an invalid structured result across the following normal request', () => {
    expect(validateStructuredOutputResult(object, { content: 'invalid' }).status).toBe('invalid');
    expect(prepareStructuredOutput({ mode: 'text' })).toEqual({ mode: 'text' });
    expect(validateStructuredOutputResult(prepareStructuredOutput(), { content: 'normal' }).status).toBe('not_applicable');
  });
});
