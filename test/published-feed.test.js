import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HushhApiClient } from "../src/hushh-api-client.js";
import {
  assertNoForbiddenPublicKeys,
  buildPublishedLearningSnapshot,
} from "../src/published-feed.js";

describe("published learning snapshots", () => {
  it("keeps only customer-safe fields", () => {
    const snapshot = buildPublishedLearningSnapshot({
      creatorId: "creator_123",
      feed: sampleCustomerPublicFeed(),
      title: "Founder decisions",
    });

    assert.equal(snapshot.schema, "hushh.zerodha.learning_snapshot.v1");
    assert.equal(snapshot.creator_id, "creator_123");
    assert.equal(snapshot.redaction, "customer_public");
    assert.equal(snapshot.decision_events[0].quantity_band, "10-25");
    assert.equal(snapshot.decision_events[0].execution_price_band, "INR 1000-2500");
    assert.equal(snapshot.decision_events[0].quantity, undefined);
    assert.equal(snapshot.portfolio_context.profile, undefined);
    assert.match(snapshot.content_hash, /^[a-f0-9]{64}$/);
  });

  it("rejects private feeds before publication", () => {
    assert.throws(
      () =>
        buildPublishedLearningSnapshot({
          creatorId: "creator_123",
          feed: { ...sampleCustomerPublicFeed(), redaction: "private" },
        }),
      /Only customer_public feeds/,
    );
  });

  it("rejects forbidden broker keys in public payloads", () => {
    assert.throws(
      () => assertNoForbiddenPublicKeys({ data: { order_id: "abc" } }),
      /Forbidden public key/,
    );
  });
});

describe("Hushh API client", () => {
  it("publishes snapshots with only a Hushh token", async () => {
    const calls = [];
    const client = new HushhApiClient({
      apiUrl: "https://api.example.test",
      token: "hushh-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ ok: true, snapshot_id: "snap_123" });
      },
    });
    const snapshot = buildPublishedLearningSnapshot({
      creatorId: "creator_123",
      feed: sampleCustomerPublicFeed(),
    });

    const result = await client.publishLearningSnapshot(snapshot);

    assert.equal(result.snapshot_id, "snap_123");
    assert.equal(calls[0].url, "https://api.example.test/api/zerodha/learning-snapshots");
    assert.equal(calls[0].options.headers.Authorization, "Bearer hushh-token");
    assert.equal(JSON.parse(calls[0].options.body).content_hash, snapshot.content_hash);
  });

  it("blocks public feed responses that contain raw broker fields", async () => {
    const client = new HushhApiClient({
      apiUrl: "https://api.example.test",
      token: "feed-token",
      fetchImpl: async () => jsonResponse({ ok: true, order_id: "raw-order" }),
    });

    await assert.rejects(
      () => client.fetchPublicLearningFeed({ creatorId: "creator_123" }),
      /Forbidden public key/,
    );
  });
});

function sampleCustomerPublicFeed() {
  return {
    ok: true,
    provider: "zerodha",
    fetched_at: "2026-06-26T10:00:00.000Z",
    redaction: "customer_public",
    portfolio_snapshot: {
      provider: "zerodha",
      fetched_at: "2026-06-26T10:00:00.000Z",
      totals: {
        holdings_count: 1,
        open_net_positions_count: 0,
        total_holding_value_band: "INR 1L-5L",
        total_holding_pnl_band: "INR 10K-50K",
        net_position_pnl_band: "INR 0",
      },
      holdings: [
        {
          symbol: "INFY",
          exchange: "NSE",
          product: "CNC",
          allocation_pct: 100,
          quantity_band: "10-25",
          market_value_band: "INR 1L-5L",
          pnl_band: "INR 10K-50K",
        },
      ],
      positions: { net: [], day: [] },
    },
    decision_events: [
      {
        type: "executed_trade",
        timestamp: "2026-06-26 09:15:00",
        symbol: "INFY",
        exchange: "NSE",
        side: "BUY",
        product: "CNC",
        order_type: "LIMIT",
        quantity: "10-25",
        execution_price: "INR 1000-2500",
        learning_angle: "entry_or_accumulation",
      },
    ],
    learning_prompts: ["What changed in exposure?"],
    data_quality: {
      trade_history_scope: "current day only",
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
