import { calculate, getCurrentDatetime, LOCAL_TOOL_BUILTIN_LIMITS, LocalToolInputError } from '../../src/services/LocalToolBuiltins';

function expectCategory(run: () => unknown, category: LocalToolInputError['category']) {
  expect(run).toThrow(LocalToolInputError);
  try { run(); } catch (error) {
    expect(error).toHaveProperty('category', category);
  }
}

describe('calculate', () => {
  test.each([
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['12 / 3 / 2', 2],
    ['8 - 3 - 1', 4], [' -.5 * (+4. + 2)', -3], ['1--2', 3], ['-0', 0],
  ])('evaluates decimal arithmetic: %s', (expression, value) => {
    expect(calculate(expression)).toEqual({ value });
  });
  test.each(['', ' ', '2**3', '2%3', 'Math.random()', '1e2', '0xff', 'NaN', 'Infinity',
    '2(3)', '1 2', '1.2.3', '()', '(2', '2)', '1+', '.'])('rejects unsupported or incomplete input %s', (expression) => {
    expectCategory(() => calculate(expression), 'invalid_expression');
  });
  test.each(['1/0', '1/-0', '1/(2-2)'])('rejects zero division %s', (expression) => {
    expectCategory(() => calculate(expression), 'division_by_zero');
  });
  it('rejects overflowing literals and intermediate results', () => {
    expectCategory(() => calculate('9'.repeat(309)), 'numeric_overflow');
    expectCategory(() => calculate(`${'9'.repeat(200)} * ${'9'.repeat(200)}`), 'numeric_overflow');
  });
  it('bounds expression length, operations, parentheses and unary recursion', () => {
    const limits = LOCAL_TOOL_BUILTIN_LIMITS;
    expect(calculate('1'.padEnd(limits.expressionCharacters))).toEqual({ value: 1 });
    expectCategory(() => calculate('1'.padEnd(limits.expressionCharacters + 1)), 'expression_limit');
    expect(calculate(Array(limits.arithmeticOperations + 1).fill('1').join('+'))).toEqual({ value: 65 });
    expectCategory(() => calculate(Array(limits.arithmeticOperations + 2).fill('1').join('+')), 'expression_limit');
    expect(calculate('('.repeat(limits.expressionDepth) + '1' + ')'.repeat(limits.expressionDepth))).toEqual({ value: 1 });
    expectCategory(() => calculate('('.repeat(limits.expressionDepth + 1) + '1' + ')'.repeat(limits.expressionDepth + 1)), 'expression_limit');
    expectCategory(() => calculate('-'.repeat(limits.expressionDepth + 1) + '1'), 'expression_limit');
    expect(Object.isFrozen(limits)).toBe(true);
  });
  it('does not include arguments in errors', () => {
    expect(() => calculate('secret-document-content')).toThrow('Expression must contain only supported arithmetic.');
  });
});

describe('getCurrentDatetime', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:15:30.123Z')); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  it('returns the device clock instant with explicit UTC fields', () => {
    expect(getCurrentDatetime('UTC')).toEqual({
      isoUtc: '2026-01-01T00:15:30.123Z', date: '2026-01-01', time: '00:15:30', timeZone: 'UTC', utcOffset: '+00:00',
    });
  });
  it('handles date rollover and fractional-hour offsets', () => {
    expect(getCurrentDatetime('America/New_York')).toMatchObject({ date: '2025-12-31', time: '19:15:30', utcOffset: '-05:00' });
    expect(getCurrentDatetime('Asia/Kathmandu')).toMatchObject({ date: '2026-01-01', time: '06:00:30', utcOffset: '+05:45' });
  });
  it('uses current daylight saving offset', () => {
    jest.setSystemTime(new Date('2026-07-01T00:15:30Z'));
    expect(getCurrentDatetime('America/New_York')).toMatchObject({ date: '2026-06-30', time: '20:15:30', utcOffset: '-04:00' });
  });
  it('defaults to the device zone', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getCurrentDatetime()).toEqual(getCurrentDatetime(zone));
  });
  test.each(['', '   ', 'unsupported/private-zone', 'x'.repeat(129)])('rejects invalid zones without fallback: %s', (zone) => {
    expectCategory(() => getCurrentDatetime(zone), 'invalid_timezone');
    expect(() => getCurrentDatetime(zone)).toThrow('Time zone is not supported.');
  });
});
