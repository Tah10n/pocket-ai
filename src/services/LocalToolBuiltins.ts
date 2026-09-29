export const LOCAL_TOOL_BUILTIN_LIMITS = Object.freeze({
  expressionCharacters: 512,
  arithmeticOperations: 64,
  expressionDepth: 16,
  timeZoneCharacters: 128,
});

const INPUT_ERRORS = {
  invalid_expression: 'Expression must contain only supported arithmetic.',
  expression_limit: 'Expression exceeds the calculation limits.',
  division_by_zero: 'Division by zero is not supported.',
  numeric_overflow: 'Calculation exceeds the finite numeric range.',
  invalid_timezone: 'Time zone is not supported.',
  datetime_unavailable: 'Device date and time are unavailable.',
} as const;

export type LocalToolInputErrorCategory = keyof typeof INPUT_ERRORS;

/** Static messages deliberately exclude model-provided arguments. */
export class LocalToolInputError extends Error {
  constructor(readonly category: LocalToolInputErrorCategory) {
    super(INPUT_ERRORS[category]);
    this.name = 'LocalToolInputError';
  }
}

/** Bounded decimal arithmetic using device IEEE-754 numbers, never executable code. */
export function calculate(expression: string): { value: number } {
  if (typeof expression !== 'string') {
    throw new LocalToolInputError('invalid_expression');
  }
  if (expression.length > LOCAL_TOOL_BUILTIN_LIMITS.expressionCharacters) {
    throw new LocalToolInputError('expression_limit');
  }
  if (!expression.trim() || !/^[0-9.+*/()\-\s]+$/.test(expression)) {
    throw new LocalToolInputError('invalid_expression');
  }
  let position = 0;
  let operations = 0;
  const fail = (): never => { throw new LocalToolInputError('invalid_expression'); };
  const skipWhitespace = () => {
    while (position < expression.length && /\s/.test(expression[position])) position += 1;
  };
  const operation = () => {
    operations += 1;
    if (operations > LOCAL_TOOL_BUILTIN_LIMITS.arithmeticOperations) {
      throw new LocalToolInputError('expression_limit');
    }
  };
  const finite = (value: number): number => {
    if (!Number.isFinite(value)) throw new LocalToolInputError('numeric_overflow');
    return value;
  };
  const primary = (depth: number): number => {
    if (depth > LOCAL_TOOL_BUILTIN_LIMITS.expressionDepth) {
      throw new LocalToolInputError('expression_limit');
    }
    skipWhitespace();
    const char = expression[position];
    if (char === '+' || char === '-') {
      position += 1;
      operation();
      const value = primary(depth + 1);
      return char === '-' ? -value : value;
    }
    if (char === '(') {
      position += 1;
      const value = sum(depth + 1);
      skipWhitespace();
      if (expression[position] !== ')') fail();
      position += 1;
      return value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(expression.slice(position));
    if (!match) return fail();
    position += match[0].length;
    return finite(Number(match[0]));
  };
  const product = (depth: number): number => {
    let value = primary(depth);
    skipWhitespace();
    while (expression[position] === '*' || expression[position] === '/') {
      const operator = expression[position++];
      operation();
      const right = primary(depth);
      if (operator === '/' && right === 0) throw new LocalToolInputError('division_by_zero');
      value = finite(operator === '*' ? value * right : value / right);
      skipWhitespace();
    }
    return value;
  };
  const sum = (depth: number): number => {
    let value = product(depth);
    skipWhitespace();
    while (expression[position] === '+' || expression[position] === '-') {
      const operator = expression[position++];
      operation();
      const right = product(depth);
      value = finite(operator === '+' ? value + right : value - right);
      skipWhitespace();
    }
    return value;
  };
  const value = sum(0);
  if (position !== expression.length) fail();
  return { value: Object.is(value, -0) ? 0 : value };
}

export interface LocalDatetimeResult {
  isoUtc: string;
  date: string;
  time: string;
  timeZone: string;
  utcOffset: string;
}

/** Uses the device clock and Intl time-zone database; no network or fallback zone. */
export function getCurrentDatetime(timeZone?: string): LocalDatetimeResult {
  if (timeZone !== undefined && (typeof timeZone !== 'string' || !timeZone.trim()
    || timeZone.length > LOCAL_TOOL_BUILTIN_LIMITS.timeZoneCharacters)) {
    throw new LocalToolInputError('invalid_timezone');
  }
  const now = new Date();
  if (!Number.isFinite(now.getTime())) throw new LocalToolInputError('datetime_unavailable');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      ...(timeZone === undefined ? {} : { timeZone }),
      calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new LocalToolInputError(timeZone === undefined ? 'datetime_unavailable' : 'invalid_timezone');
  }
  try {
    const parts = formatter.formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string => {
      const value = parts.find((item) => item.type === type)?.value;
      if (!value || !/^\d+$/.test(value)) throw new LocalToolInputError('datetime_unavailable');
      return value;
    };
    const year = part('year');
    const month = part('month');
    const day = part('day');
    const hour = part('hour');
    const minute = part('minute');
    const second = part('second');
    // Compare the same instant's local calendar fields with UTC, including DST and date rollover.
    const localAsUtc = new Date(0);
    localAsUtc.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    localAsUtc.setUTCHours(Number(hour), Number(minute), Number(second), 0);
    const offsetMinutes = Math.round((localAsUtc.getTime() - Math.floor(now.getTime() / 1000) * 1000) / 60000);
    const absoluteOffset = Math.abs(offsetMinutes);
    const utcOffset = `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
    const resolvedZone = formatter.resolvedOptions().timeZone;
    return {
      isoUtc: now.toISOString(),
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`,
      timeZone: resolvedZone || `UTC${utcOffset}`,
      utcOffset,
    };
  } catch {
    throw new LocalToolInputError('datetime_unavailable');
  }
}
