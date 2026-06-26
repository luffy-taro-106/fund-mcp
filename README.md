# Fund MCP

Read-only Zerodha Kite MCP connector for Hushh decision-learning workflows.

The product deployment should use two different surfaces:

```text
private owner runtime -> Hushh API -> customer MCP/client
        |
        v
      Zerodha
```

Customers should never connect to the private Zerodha runtime. They should connect only to the Hushh learning feed surface, which reads Hushh-published redacted snapshots.

This package is intentionally scoped to portfolio and trade-log retrieval:

- portfolio holdings
- net/day positions
- current-day tradebook
- current-day orderbook
- a redacted, educational decision-learning feed

It does **not** expose trade placement, order modification, order cancellation, GTT, margin, or fund-transfer tools.

## Modes

Set `HUSHH_ZERODHA_MCP_MODE` to choose which surface starts.

### `private_ingest`

Owner-only runtime. This mode may read Zerodha and may publish a redacted snapshot to Hushh API.

Tools:

- `hushh_zerodha_login_url`
- `hushh_zerodha_exchange_request_token`
- `hushh_zerodha_portfolio`
- `hushh_zerodha_recent_trade_logs`
- `hushh_zerodha_learning_feed`
- `hushh_zerodha_publish_learning_snapshot`

Required for publish:

```bash
export HUSHH_ZERODHA_MCP_MODE=private_ingest
export HUSHH_API_URL="https://api.hushh.ai"
export HUSHH_INGEST_TOKEN="<hushh-private-ingest-token>"
export HUSHH_CREATOR_ID="<creator-id>"
```

`hushh_zerodha_publish_learning_snapshot` always publishes a `customer_public` snapshot. It will not publish private-mode data.

### `public_learning`

Customer-facing runtime. This mode cannot call Zerodha and does not register Zerodha tools. It only calls Hushh API for already-published redacted learning data.

Tool:

- `hushh_public_zerodha_learning_feed`

Config:

```bash
export HUSHH_ZERODHA_MCP_MODE=public_learning
export HUSHH_API_URL="https://api.hushh.ai"
export HUSHH_LEARNING_FEED_TOKEN="<hushh-learning-feed-token>"
export HUSHH_CREATOR_ID="<creator-id>"
```

Print customer-facing config:

```bash
npx -y fund-mcp --print-public-config
npx -y fund-mcp --print-public-codex-toml
```

## Why this shape

For a product where customers learn from a founder or manager's decisions, the MCP should publish a consented decision journal, not a copy-trading API. The default `customer_public` redaction keeps symbols, side, product, timing, tags, and allocation bands while removing exact prices, quantities, broker ids, and account identifiers.

Customer-facing output still needs product/legal review. Present it as historical education, not personalized financial advice.

## Zerodha/Kite API scope

The connector uses official Kite Connect v3 endpoints:

- `POST /session/token`
- `GET /user/profile`
- `GET /portfolio/holdings`
- `GET /portfolio/positions`
- `GET /orders`
- `GET /trades`

Kite's `/orders` and `/trades` endpoints are day-scoped orderbook/tradebook surfaces. If the product needs multi-day history, schedule a consented daily sync into Hushh-owned storage rather than trying to recover old tradebook rows from this MCP.

Docs:

- [Kite Connect v3](https://kite.trade/docs/connect/v3/)
- [Portfolio APIs](https://kite.trade/docs/connect/v3/portfolio/)
- [Orders and trades APIs](https://kite.trade/docs/connect/v3/orders/)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)

## Install

```bash
npm install
```

## Local MCP config

```json
{
  "mcpServers": {
    "hushh-zerodha": {
      "command": "npx",
      "args": ["-y", "fund-mcp"],
      "env": {
        "HUSHH_ZERODHA_MCP_MODE": "private_ingest",
        "ZERODHA_API_KEY": "<kite-api-key>",
        "ZERODHA_API_SECRET": "<kite-api-secret>",
        "ZERODHA_ACCESS_TOKEN": "<daily-access-token-optional>",
        "HUSHH_API_URL": "https://api.hushh.ai",
        "HUSHH_INGEST_TOKEN": "<hushh-private-ingest-token>",
        "HUSHH_CREATOR_ID": "<creator-id>"
      }
    }
  }
}
```

Print config:

```bash
npx -y fund-mcp --print-config
npx -y fund-mcp --print-codex-toml
```

## Auth flow

1. Set `ZERODHA_API_KEY` locally.
2. Call `hushh_zerodha_login_url` to get the Kite login URL.
3. Open it outside the MCP and complete Zerodha login.
4. Copy the returned `request_token`.
5. Set `ZERODHA_API_SECRET` locally.
6. Call `hushh_zerodha_exchange_request_token`.

The exchange tool stores the daily access token in a local session file with `0600` permissions and does not return the token to the MCP host.

Environment:

```bash
export ZERODHA_API_KEY="<kite-api-key>"
export ZERODHA_API_SECRET="<kite-api-secret>"
export ZERODHA_ACCESS_TOKEN="<daily-access-token-optional>"
export ZERODHA_SESSION_PATH="$HOME/.hushh/zerodha-mcp/session.json"
```

## Redaction modes

`customer_public` is the default:

- removes order ids, trade ids, exchange ids, user ids, and emails
- buckets exact quantity, price, value, and P&L
- keeps symbol, exchange, side, product, order type, status, timestamp, and tags

`private` is for owner-approved internal workflows:

- keeps exact broker-returned numeric values
- still does not return API secrets or access tokens

## Developer guardrails

- Do not commit `ZERODHA_API_SECRET`, `ZERODHA_ACCESS_TOKEN`, or session files.
- Do not run the MCP with founder credentials in a shared customer environment.
- Do not expose `private_ingest` mode to customers.
- Do not give customer-facing MCP hosts `ZERODHA_*` env vars.
- Do not add write-capable Kite endpoints to this package.
- Do not imply that the learning feed is investment advice.
- Add Hushh consent receipts and retention controls before storing broker data server-side.

## Hushh API contract

The MCP expects these product API boundaries:

- `POST /api/zerodha/learning-snapshots`
  - private ingestion endpoint
  - accepts `hushh.zerodha.learning_snapshot.v1`
  - authenticated by `HUSHH_INGEST_TOKEN`
- `GET /api/learning/creators/{creator_id}/zerodha/feed?limit=20`
  - customer-facing read endpoint
  - returns only published redacted snapshots/events
  - authenticated by `HUSHH_LEARNING_FEED_TOKEN`

The public MCP scans Hushh API responses and refuses payloads that contain raw broker keys such as `order_id`, `trade_id`, `quantity`, `price`, `pnl`, `access_token`, or `user_id`.

## Test

The tests mock network calls and do not connect to Zerodha:

```bash
npm test
```
