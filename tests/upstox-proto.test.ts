/**
 * Protobuf decoding tests for Market Data Feed V3.
 *
 * Frames are built by an independent encoder (tests/helpers/proto-encode.ts)
 * that shares no code with the decoder, so a matching bug in both cannot hide.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFeedResponse, FEED_TYPE, isMarketClosed, REQUEST_MODE,
} from '../src/adapters/tier1/upstox/proto/feed.ts';
import { decodeMessage, getDouble, getInt64, ProtoError } from '../src/adapters/tier1/upstox/proto/wire.ts';
import * as pb from './helpers/proto-encode.ts';

describe('protobuf wire format', () => {
  test('round-trips a double', () => {
    const msg = decodeMessage(pb.fieldDouble(1, 2456.75));
    assert.equal(getDouble(msg, 1), 2456.75);
  });

  test('round-trips multi-byte varints', () => {
    for (const value of [0, 1, 127, 128, 300, 1_755_000_000_000]) {
      assert.equal(getInt64(decodeMessage(pb.fieldVarint(1, value)), 1), value);
    }
  });

  test('distinguishes an absent field from a zero value', () => {
    const present = decodeMessage(pb.fieldVarint(1, 0));
    assert.equal(getInt64(present, 1), 0);
    assert.equal(getInt64(present, 2), undefined, 'absent must be undefined, not 0');
  });

  test('skips unknown fields instead of failing', () => {
    // Forward compatibility: Upstox adding a field must not break decoding.
    const frame = pb.message(pb.fieldDouble(1, 100), pb.fieldString(99, 'future field'));
    assert.equal(getDouble(decodeMessage(frame), 1), 100);
  });

  test('rejects a truncated varint', () => {
    assert.throws(() => decodeMessage(new Uint8Array([0x08, 0xff])), ProtoError);
  });

  test('rejects a length-delimited field that overruns the buffer', () => {
    assert.throws(() => decodeMessage(new Uint8Array([0x12, 0x40, 0x01])), ProtoError);
  });

  test('rejects field number zero', () => {
    assert.throws(() => decodeMessage(new Uint8Array([0x00, 0x01])), ProtoError);
  });
});

describe('FeedResponse decoding', () => {
  test('decodes an equity full feed', () => {
    const frame = pb.feedResponse({
      type: FEED_TYPE.live_feed,
      currentTs: 1_755_000_060_000,
      feeds: {
        'NSE_EQ|INE002A01018': pb.equityFeed({
          ltpc: { ltp: 2456.75, ltt: 1_755_000_059_000, ltq: 42, cp: 2440.1 },
          vtt: 1_250_000,
          atp: 2450.5,
          requestMode: REQUEST_MODE.full_d5,
        }),
      },
    });

    const decoded = decodeFeedResponse(frame);
    assert.equal(decoded.type, FEED_TYPE.live_feed);
    assert.equal(decoded.currentTs, 1_755_000_060_000);
    assert.equal(decoded.feeds.length, 1);

    const feed = decoded.feeds[0]!;
    assert.equal(feed.instrumentKey, 'NSE_EQ|INE002A01018');
    assert.equal(feed.ltpc?.ltp, 2456.75);
    assert.equal(feed.ltpc?.ltt, 1_755_000_059_000);
    assert.equal(feed.ltpc?.ltq, 42);
    assert.equal(feed.ltpc?.cp, 2440.1);
    assert.equal(feed.vtt, 1_250_000);
    assert.equal(feed.atp, 2450.5);
    assert.equal(feed.isIndex, false);
  });

  test('decodes an index feed and flags it as an index', () => {
    const frame = pb.feedResponse({
      type: FEED_TYPE.live_feed,
      feeds: {
        'NSE_INDEX|Nifty 50': pb.indexFeed({
          ltpc: { ltp: 24_150.3, ltt: 1_755_000_059_000, cp: 24_050.0 },
          ohlc: [{ interval: '1d', open: 24_060, high: 24_200, low: 24_040, close: 24_150.3 }],
        }),
      },
    });

    const feed = decodeFeedResponse(frame).feeds[0]!;
    assert.equal(feed.isIndex, true, 'indices have no volume and must be distinguishable');
    assert.equal(feed.ltpc?.ltp, 24_150.3);
    assert.equal(feed.vtt, null, 'an index carries no traded volume');
    assert.equal(feed.ohlc.length, 1);
    assert.equal(feed.ohlc[0]!.high, 24_200);
  });

  test('decodes a bare LTPC feed (ltpc mode)', () => {
    const frame = pb.feedResponse({
      feeds: { 'NSE_EQ|INE009A01021': pb.ltpcFeed({ ltp: 1500.25, ltt: 1_755_000_000_000 }) },
    });
    const feed = decodeFeedResponse(frame).feeds[0]!;
    assert.equal(feed.ltpc?.ltp, 1500.25);
    assert.equal(feed.vtt, null, 'ltpc mode carries no cumulative volume');
  });

  test('decodes multiple instruments in one frame', () => {
    const frame = pb.feedResponse({
      feeds: {
        'NSE_EQ|A': pb.equityFeed({ ltpc: { ltp: 10 } }),
        'NSE_EQ|B': pb.equityFeed({ ltpc: { ltp: 20 } }),
        'NSE_INDEX|Nifty 50': pb.indexFeed({ ltpc: { ltp: 24_000 } }),
      },
    });
    const decoded = decodeFeedResponse(frame);
    assert.equal(decoded.feeds.length, 3);
    assert.deepEqual(
      decoded.feeds.map((f) => f.instrumentKey).sort(),
      ['NSE_EQ|A', 'NSE_EQ|B', 'NSE_INDEX|Nifty 50'],
    );
  });

  test('an empty frame decodes to no feeds rather than throwing', () => {
    const decoded = decodeFeedResponse(new Uint8Array(0));
    assert.equal(decoded.feeds.length, 0);
  });
});

describe('market status', () => {
  test('decodes segment status from a market_info frame', () => {
    const frame = pb.feedResponse({
      type: FEED_TYPE.market_info,
      segmentStatus: { NSE_EQ: 2, NSE_FO: 2 },
    });
    const decoded = decodeFeedResponse(frame);
    assert.equal(decoded.type, FEED_TYPE.market_info);
    assert.equal(decoded.segmentStatus.get('NSE_EQ'), 'NORMAL_OPEN');
    assert.equal(isMarketClosed(decoded.segmentStatus), false);
  });

  test('detects market closed when every segment is closed', () => {
    const frame = pb.feedResponse({
      type: FEED_TYPE.market_info,
      segmentStatus: { NSE_EQ: 3, NSE_FO: 3 },
    });
    const decoded = decodeFeedResponse(frame);
    assert.equal(decoded.segmentStatus.get('NSE_EQ'), 'NORMAL_CLOSE');
    assert.equal(isMarketClosed(decoded.segmentStatus), true);
  });

  test('a partially open market is not reported as closed', () => {
    const frame = pb.feedResponse({ segmentStatus: { NSE_EQ: 2, NSE_FO: 3 } });
    assert.equal(isMarketClosed(decodeFeedResponse(frame).segmentStatus), false);
  });

  test('no status information is not the same as closed', () => {
    assert.equal(isMarketClosed(new Map()), false);
  });
});

describe('malformed frames', () => {
  test('random bytes either throw ProtoError or decode to nothing, never crash', () => {
    const seeds = [
      new Uint8Array([0xff, 0xff, 0xff]),
      new Uint8Array([0x0f]),
      new Uint8Array([0x12, 0xff, 0x7f]),
      new Uint8Array([0x08]),
      new Uint8Array([0x1c, 0x05, 0x00]),
    ];
    for (const bytes of seeds) {
      try {
        decodeFeedResponse(bytes);
      } catch (err) {
        assert.ok(err instanceof ProtoError, `expected ProtoError, got ${String(err)}`);
      }
    }
  });

  test('a truncated valid frame throws rather than yielding partial garbage', () => {
    const frame = pb.feedResponse({
      feeds: { 'NSE_EQ|A': pb.equityFeed({ ltpc: { ltp: 100, ltt: 1_755_000_000_000 } }) },
    });
    assert.throws(() => decodeFeedResponse(frame.subarray(0, frame.length - 3)), ProtoError);
  });
});
