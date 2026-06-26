import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLearningFeed,
  buildLoginUrl,
  buildPortfolioSnapshot,
  buildRecentTradeLogs,
  computeChecksum,
  sanitizeSessionProfile,
  ZerodhaClient,
} from "../src/zerodha-client.js";

describe("Zerodha client helpers", () => {
  it("computes the Kite Connect request_token checksum", () => {
    const checksum = computeChecksum({
      apiKey: "api_key",
      requestToken: "request_token",
      apiSecret: "api_secret",
    });

    assert.equal(
      checksum,
      "ff6a6d3d60c9d974df906ba6f787ac38300cfa68b41801b486ea1007e52e8942",
    );
  });

  it("builds the Kite login URL without calling the network", () => {
    const url = buildLoginUrl({
      apiKey: "abc123",
      redirectParams: { state: "demo", customer_id: 42 },
    });

    assert.match(url, /^https:\/\/kite\.zerodha\.com\/connect\/login\?/);
    assert.match(url, /api_key=abc123/);
    assert.match(url, /redirect_params=/);
  });

  it("sanitizes session profile without returning tokens", () => {
    const profile = sanitizeSessionProfile({
      user_id: "AB1234",
      user_name: "Test User",
      email: "founder@example.com",
      broker: "ZERODHA",
      access_token: "secret-token",
      exchanges: ["NSE"],
      products: ["CNC"],
    });

    assert.equal(profile.user_id, "AB1234");
    assert.equal(profile.email, "fo*****@example.com");
    assert.equal(profile.access_token, undefined);
  });
});

describe("Zerodha API client", () => {
  it("uses the Kite token auth header for read-only requests", async () => {
    const calls = [];
    const client = new ZerodhaClient({
      apiKey: "key",
      accessToken: "access",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ status: "success", data: [] });
      },
    });

    await client.holdings();

    assert.equal(calls[0].url, "https://api.kite.trade/portfolio/holdings");
    assert.equal(calls[0].options.headers.Authorization, "token key:access");
    assert.equal(calls[0].options.method, "GET");
  });

  it("exchanges request_token with form data and does not require an existing access token", async () => {
    const calls = [];
    const client = new ZerodhaClient({
      apiKey: "api_key",
      apiSecret: "api_secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          status: "success",
          data: {
            access_token: "new_access",
            user_id: "AB1234",
            broker: "ZERODHA",
          },
        });
      },
    });

    const session = await client.exchangeRequestToken("request_token");

    assert.equal(session.access_token, "new_access");
    assert.equal(client.accessToken, "new_access");
    assert.equal(calls[0].url, "https://api.kite.trade/session/token");
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.match(calls[0].options.body, /checksum=/);
  });
});

describe("portfolio and trade shaping", () => {
  it("redacts public portfolio snapshots into bands and allocation percentages", () => {
    const snapshot = buildPortfolioSnapshot({
      redaction: "customer_public",
      holdings: [
        {
          tradingsymbol: "INFY",
          exchange: "NSE",
          product: "CNC",
          quantity: 10,
          average_price: 1000,
          last_price: 1500,
          pnl: 5000,
          day_change_percentage: 1.2,
        },
        {
          tradingsymbol: "TCS",
          exchange: "NSE",
          product: "CNC",
          quantity: 5,
          average_price: 3000,
          last_price: 4000,
          pnl: 5000,
          day_change_percentage: -0.4,
        },
      ],
      positions: { net: [], day: [] },
    });

    assert.equal(snapshot.totals.holdings_count, 2);
    assert.equal(snapshot.holdings[0].symbol, "TCS");
    assert.equal(snapshot.holdings[0].quantity, undefined);
    assert.equal(snapshot.holdings[0].quantity_band, "1-5");
    assert.equal(snapshot.holdings[0].allocation_pct, 57.14);
  });

  it("sorts and redacts recent trades and orders", () => {
    const logs = buildRecentTradeLogs({
      redaction: "customer_public",
      limit: 2,
      includeOrders: true,
      trades: [
        {
          trade_id: "t1",
          order_id: "o1",
          fill_timestamp: "2026-06-25 09:15:00",
          tradingsymbol: "INFY",
          exchange: "NSE",
          transaction_type: "BUY",
          product: "CNC",
          quantity: 13,
          average_price: 1511.25,
        },
        {
          trade_id: "t2",
          order_id: "o2",
          fill_timestamp: "2026-06-25 10:15:00",
          tradingsymbol: "TCS",
          exchange: "NSE",
          transaction_type: "SELL",
          product: "CNC",
          quantity: 2,
          average_price: 4010,
        },
      ],
      orders: [
        {
          order_id: "o1",
          order_timestamp: "2026-06-25 09:14:59",
          tradingsymbol: "INFY",
          exchange: "NSE",
          transaction_type: "BUY",
          product: "CNC",
          order_type: "LIMIT",
          status: "COMPLETE",
          tag: "inversion",
          quantity: 13,
          price: 1510,
        },
      ],
    });

    assert.equal(logs.trades.length, 2);
    assert.equal(logs.trades[0].symbol, "TCS");
    assert.equal(logs.trades[0].trade_id, undefined);
    assert.equal(logs.trades[1].tag, "inversion");
    assert.equal(logs.trades[1].price_band, "INR 1000-2500");
  });

  it("builds an educational learning feed without advice language", () => {
    const feed = buildLearningFeed({
      redaction: "customer_public",
      limit: 5,
      portfolio: null,
      tradeLogs: {
        scope_note: "current day only",
        trades: [
          {
            timestamp: "2026-06-25 10:15:00",
            symbol: "TCS",
            exchange: "NSE",
            side: "SELL",
            product: "CNC",
            quantity_band: "1-5",
            price_band: "INR 2500-5000",
          },
        ],
        orders: [
          {
            timestamp: "2026-06-25 10:14:00",
            symbol: "TCS",
            exchange: "NSE",
            side: "SELL",
            product: "CNC",
            order_type: "LIMIT",
            status: "CANCELLED",
          },
        ],
      },
    });

    assert.equal(feed.product_boundary.mode, "read_only");
    assert.equal(feed.product_boundary.not_included.includes("copy-trading instructions"), true);
    assert.equal(feed.decision_events[0].type, "executed_trade");
  });
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
