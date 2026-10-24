import { describe, expect, it } from 'vitest';
import { createFormatters } from './formatters.js';
import { collectArgs, formatNodes, parseMessage } from './icu.js';

const en = createFormatters('en');

function fmt(source: string, params: Record<string, unknown> = {}, formatters = en): string {
  const parsed = parseMessage(source);
  if (!parsed.ok) throw parsed.error;
  return formatNodes(parsed.value, params, formatters).text;
}

describe('parseMessage', () => {
  it('parses plain text and simple args', () => {
    expect(fmt('Hello')).toBe('Hello');
    expect(fmt('Hello {name}!', { name: 'Ada' })).toBe('Hello Ada!');
    expect(fmt('Hi { name }', { name: 'Ada' })).toBe('Hi Ada');
  });

  it('handles apostrophe quoting', () => {
    expect(fmt("It''s {name}", { name: 'x' })).toBe("It's x");
    expect(fmt("Use '{braces}' literally")).toBe('Use {braces} literally');
    expect(fmt("don't")).toBe("don't");
    expect(fmt("'{unterminated")).toBe('{unterminated');
    expect(fmt("{n, plural, other {'#' is # }}", { n: 2 })).toBe('# is 2 ');
    expect(fmt("'{a''b}'")).toBe("{a'b}");
  });

  it('reports syntax errors as SF-I18N-001 results', () => {
    for (const bad of ['Hello {name', 'oops }', '{n, plural, one {x}}', '{n, bogus}', '{, x}', '{n, plural, =x {a} other {b}}', '{n, plural, offset: other {b}}', '{n, select, a {x} other {y}', '{n, plural, other x}']) {
      const result = parseMessage(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SF-I18N-001');
    }
  });

  it('collects argument kinds', () => {
    const parsed = parseMessage('{a} {b, number} {c, date, short} {d, plural, one {{e}} other {#}} {f, select, x {{g, time}} other {}} {h, list} {i, selectordinal, other {#}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.fromEntries(collectArgs(parsed.value))).toEqual({
      a: 'plain',
      b: 'number',
      c: 'date',
      d: 'plural',
      e: 'plain',
      f: 'select',
      g: 'time',
      h: 'list',
      i: 'selectordinal',
    });
  });
});

describe('formatNodes', () => {
  it('plural: exact matches, categories and #', () => {
    const msg = '{count, plural, =0 {No items} one {# item} other {# items}}';
    expect(fmt(msg, { count: 0 })).toBe('No items');
    expect(fmt(msg, { count: 1 })).toBe('1 item');
    expect(fmt(msg, { count: 1234 })).toBe('1,234 items');
  });

  it('plural with offset', () => {
    const msg = '{n, plural, offset:1 =0 {nobody} =1 {only {who}} one {{who} and # other} other {{who} and # others}}';
    expect(fmt(msg, { n: 0, who: 'Ada' })).toBe('nobody');
    expect(fmt(msg, { n: 1, who: 'Ada' })).toBe('only Ada');
    expect(fmt(msg, { n: 2, who: 'Ada' })).toBe('Ada and 1 other');
    expect(fmt(msg, { n: 5, who: 'Ada' })).toBe('Ada and 4 others');
  });

  it('selectordinal uses ordinal rules', () => {
    const msg = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect([1, 2, 3, 4, 11, 22].map((n) => fmt(msg, { n }))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '22nd']);
  });

  it('plural rules follow the locale', () => {
    const msg = '{n, plural, one {un} few {kilka} many {wiele} other {inne}}';
    const pl = createFormatters('pl');
    expect(fmt(msg, { n: 1 }, pl)).toBe('un');
    expect(fmt(msg, { n: 3 }, pl)).toBe('kilka');
    expect(fmt(msg, { n: 5 }, pl)).toBe('wiele');
  });

  it('select with fallback to other; # inside select inside plural', () => {
    const msg = '{g, select, female {She} male {He} other {They}} replied';
    expect(fmt(msg, { g: 'female' })).toBe('She replied');
    expect(fmt(msg, { g: 'robot' })).toBe('They replied');
    expect(fmt('{n, plural, other {{g, select, a {# A} other {# B}}}}', { n: 3, g: 'a' })).toBe('3 A');
  });

  it('number styles', () => {
    expect(fmt('{n, number}', { n: 1234.5 })).toBe('1,234.5');
    expect(fmt('{n, number, integer}', { n: 1234.5 })).toBe('1,235');
    expect(fmt('{n, number, percent}', { n: 0.25 })).toBe('25%');
    expect(fmt('{n, number, ::currency/EUR}', { n: 3 })).toBe('€3.00');
    expect(fmt('{n, number, currency/usd}', { n: 3 })).toBe('$3.00');
    expect(fmt('{n, number, compact}', { n: 12000 })).toBe('12K');
    expect(fmt('{n, number, mystery}', { n: 1 })).toBe('1');
    expect(fmt('{n}', { n: 1000 })).toBe('1,000');
  });

  it('date/time args', () => {
    const when = Date.UTC(2026, 9, 24, 12, 0, 0);
    const utc = createFormatters('en');
    expect(fmt('{d, date, short}', { d: new Date(when) }, utc)).toMatch(/10\/2[45]\/26/);
    expect(fmt('{d, date}', { d: when }, utc)).toMatch(/Oct 2[45], 2026/);
    expect(fmt('{d, time, short}', { d: when }, utc)).toMatch(/\d{1,2}:\d{2}/);
    expect(fmt('{d, date}', { d: 'not a date' })).toBe('not a date');
    expect(fmt('{d}', { d: new Date(when) })).toMatch(/2026/);
  });

  it('list args', () => {
    expect(fmt('{xs, list}', { xs: ['a', 'b', 'c'] })).toBe('a, b, and c');
    expect(fmt('{xs, list, or}', { xs: ['a', 'b'] })).toBe('a or b');
    expect(fmt('{xs, list, unit}', { xs: ['a', 'b'] })).toBe('a, b');
    expect(fmt('{xs, list}', { xs: 'solo' })).toBe('solo');
  });

  it('reports missing params and keeps a visible placeholder', () => {
    const parsed = parseMessage('Hi {name}, {n, plural, other {#}}');
    if (!parsed.ok) throw parsed.error;
    const outcome = formatNodes(parsed.value, {}, en);
    expect(outcome.text).toBe('Hi {name}, {n}');
    expect(outcome.missing).toEqual(['name', 'n']);
  });

  it('a stray # outside a plural is literal', () => {
    expect(fmt('#1 fan')).toBe('#1 fan');
  });
});

describe('createFormatters fallbacks (engines without newer Intl APIs)', () => {
  const bare = createFormatters('en', { NumberFormat: Intl.NumberFormat });

  it('list and relative time degrade to readable English', () => {
    expect(bare.list(['a', 'b', 'c'])).toBe('a, b and c');
    expect(bare.list(['a', 'b'], { type: 'disjunction' })).toBe('a or b');
    expect(bare.list(['a'])).toBe('a');
    expect(bare.relativeTime(-3, 'day')).toBe('3 days ago');
    expect(bare.relativeTime(1, 'hours')).toBe('in 1 hour');
    expect(bare.pluralCategory(1)).toBe('one');
    expect(bare.pluralCategory(2)).toBe('other');
    expect(bare.date(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('no Intl at all', () => {
    const none = createFormatters('en', {});
    expect(none.number(1234.5)).toBe('1234.5');
    expect(none.currency(2, 'EUR')).toBe('2');
  });

  it('invalid options fall back instead of throwing', () => {
    expect(en.currency(1, 'not-a-currency')).toBe('1');
    expect(en.relativeTime(2, 'fortnight' as Intl.RelativeTimeFormatUnit)).toBe('in 2 fortnights');
  });

  it('caches Intl instances per options', () => {
    let built = 0;
    class Counting extends Intl.NumberFormat {
      constructor(...args: ConstructorParameters<typeof Intl.NumberFormat>) {
        super(...args);
        built += 1;
      }
    }
    const f = createFormatters('en', { NumberFormat: Counting as typeof Intl.NumberFormat });
    f.number(1);
    f.number(2);
    f.number(3, { style: 'percent' });
    expect(built).toBe(2);
  });

  it('real relative time and list formatting', () => {
    expect(en.relativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday');
    expect(createFormatters('de').list(['a', 'b'])).toBe('a und b');
  });
});
