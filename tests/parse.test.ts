import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRows, parseNumber, CsvError } from '../src/parse/csv.ts';
import { parseXml, findAll, findFirst, childText, decodeEntities, XmlError } from '../src/parse/xml.ts';
import { parseDate, parseTimestamp, tradingDate, DateParseError } from '../src/parse/dates.ts';

describe('CSV', () => {
  test('parses a header and rows, lower-casing headers', () => {
    const { headers, rows } = parseCsv('Symbol,Close\nTESTCO,101.5\n');
    assert.deepEqual(headers, ['symbol', 'close']);
    assert.deepEqual(rows, [{ symbol: 'TESTCO', close: '101.5' }]);
  });

  test('handles quoted fields containing the delimiter', () => {
    const { rows } = parseCsv('symbol,name\nX,"Acme, Limited"\n');
    assert.equal(rows[0]!['name'], 'Acme, Limited');
  });

  test('handles escaped quotes and embedded newlines', () => {
    const { rows } = parseCsv('a,b\n"say ""hi""","line1\nline2"\n');
    assert.equal(rows[0]!['a'], 'say "hi"');
    assert.equal(rows[0]!['b'], 'line1\nline2');
  });

  test('handles CRLF and a UTF-8 BOM', () => {
    const { rows, headers } = parseCsv('﻿symbol,close\r\nX,10\r\n');
    assert.deepEqual(headers, ['symbol', 'close']);
    assert.equal(rows[0]!['close'], '10');
  });

  test('trims unquoted whitespace but preserves it inside quotes', () => {
    const { rows } = parseCsv('a,b\n  x  ,"  y  "\n');
    assert.equal(rows[0]!['a'], 'x');
    assert.equal(rows[0]!['b'], '  y  ');
  });

  test('rejects a row with the wrong field count rather than padding it', () => {
    assert.throws(() => parseCsv('a,b\n1,2,3\n'), /has 3 field\(s\), expected 2/);
  });

  test('rejects an unterminated quoted field', () => {
    assert.throws(() => parseCsvRows('a\n"oops\n'), CsvError);
  });

  test('empty input yields no rows', () => {
    assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
  });

  describe('parseNumber', () => {
    test('strips comma grouping used in Indian exchange files', () => {
      assert.equal(parseNumber('1,23,456.78', 'ctx'), 123456.78);
    });

    test('treats blank, dash and NA as null when optional', () => {
      for (const v of ['', '-', 'NA', 'null']) {
        assert.equal(parseNumber(v, 'ctx', { optional: true }), null);
      }
    });

    test('throws rather than producing NaN', () => {
      assert.throws(() => parseNumber('abc', 'ctx'), /not a finite number/);
      assert.throws(() => parseNumber('', 'ctx'), /expected a number/);
    });
  });
});

describe('XML', () => {
  test('parses nested elements and attributes', () => {
    const doc = parseXml('<a><b id="1">text</b></a>');
    const b = findFirst(doc, 'b')!;
    assert.equal(b.text, 'text');
    assert.equal(b.attrs['id'], '1');
  });

  test('takes CDATA verbatim without entity decoding', () => {
    const doc = parseXml('<a><b><![CDATA[raw & <b> stuff]]></b></a>');
    assert.equal(childText(doc.children[0]!, 'b'), 'raw & <b> stuff');
  });

  test('decodes predefined and numeric entities in ordinary text', () => {
    assert.equal(decodeEntities('a &amp; b &#65; &#x42;'), 'a & b A B');
    const doc = parseXml('<a>16% &amp; rising</a>');
    assert.equal(doc.children[0]!.text, '16% & rising');
  });

  test('strips namespace prefixes from names', () => {
    const doc = parseXml('<feed xmlns:dc="x"><dc:creator>me</dc:creator></feed>');
    assert.equal(findFirst(doc, 'creator')?.text, 'me');
  });

  test('handles self-closing tags, comments and declarations', () => {
    const doc = parseXml('<?xml version="1.0"?><!-- note --><a><br/><b>x</b></a>');
    assert.equal(findAll(doc, 'br').length, 1);
    assert.equal(findFirst(doc, 'b')?.text, 'x');
  });

  test('rejects mismatched and unclosed tags', () => {
    assert.throws(() => parseXml('<a><b></a></b>'), XmlError);
    assert.throws(() => parseXml('<a><b></b>'), /unclosed tag/);
  });
});

describe('dates', () => {
  test('accepts ISO unchanged', () => {
    assert.equal(parseDate('2026-01-15'), '2026-01-15');
    assert.equal(parseDate('2026-01-15T10:30:00Z'), '2026-01-15');
  });

  test('parses named-month formats', () => {
    assert.equal(parseDate('15-Jan-2026'), '2026-01-15');
    assert.equal(parseDate('15 JAN 2026'), '2026-01-15');
    assert.equal(parseDate('01-Feb-26'), '2026-02-01');
  });

  test('parses numeric dates day-first, per Indian convention', () => {
    assert.equal(parseDate('15-01-2026'), '2026-01-15');
    assert.equal(parseDate('15/01/2026'), '2026-01-15');
    assert.equal(parseDate('01/02/2026'), '2026-02-01', 'ambiguous input resolves day-first');
  });

  test('rejects impossible and unrecognised dates', () => {
    assert.throws(() => parseDate('2026-02-30'), DateParseError);
    assert.throws(() => parseDate('32-01-2026'), DateParseError);
    assert.throws(() => parseDate('not a date'), /unrecognised date format/);
  });

  test('parses RFC 822 timestamps from RSS', () => {
    assert.equal(
      parseTimestamp('Thu, 13 Aug 2026 11:03:00 +0530'),
      '2026-08-13T05:33:00.000Z',
    );
  });

  test('a bare date becomes midnight UTC', () => {
    assert.equal(parseTimestamp('2026-08-13'), '2026-08-13T00:00:00.000Z');
  });

  describe('tradingDate', () => {
    test('maps a timestamp to its IST session date', () => {
      // 03:00 UTC = 08:30 IST, same day.
      assert.equal(tradingDate('2026-08-13T03:00:00Z'), '2026-08-13');
      // 20:00 UTC = 01:30 IST next day.
      assert.equal(tradingDate('2026-08-13T20:00:00Z'), '2026-08-14');
      // Market close 15:30 IST = 10:00 UTC.
      assert.equal(tradingDate('2026-08-13T10:00:00Z'), '2026-08-13');
    });
  });
});
