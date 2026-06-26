import crypto from "node:crypto";

export const PUBLIC_SNAPSHOT_SCHEMA = "hushh.zerodha.learning_snapshot.v1";

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "access_token",
  "api_key",
  "api_secret",
  "average_price",
  "cancelled_quantity",
  "close_price",
  "exchange_order_id",
  "filled_quantity",
  "isin",
  "last_price",
  "m2m",
  "market_value",
  "order_id",
  "parent_order_id",
  "pending_quantity",
  "pnl",
  "price",
  "profile",
  "quantity",
  "token",
  "trade_id",
  "trigger_price",
  "user_id",
]);

export function buildPublishedLearningSnapshot({
  creatorId,
  feed,
  title = "Zerodha decision journal",
  visibility = "subscribers",
  source = "zerodha",
} = {}) {
  if (!creatorId || typeof creatorId !== "string") {
    throw new Error("creatorId is required for published learning snapshots.");
  }
  if (!feed || typeof feed !== "object") {
    throw new Error("A learning feed payload is required.");
  }
  if (feed.redaction !== "customer_public") {
    throw new Error("Only customer_public feeds can be published to customer-facing surfaces.");
  }

  const snapshot = {
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    creator_id: creatorId,
    source,
    title: cleanString(title, 120),
    visibility,
    published_at: new Date().toISOString(),
    source_fetched_at: feed.fetched_at,
    provider: feed.provider,
    redaction: "customer_public",
    product_boundary: {
      purpose: "educational_decision_journal",
      mode: "published_redacted_snapshot",
      not_included: [
        "broker credentials",
        "account identifiers",
        "exact trade quantities",
        "exact prices",
        "exact P&L",
        "trade execution ids",
        "order placement",
        "personalized financial advice",
      ],
    },
    portfolio_context: sanitizePortfolioContext(feed.portfolio_snapshot),
    decision_events: (feed.decision_events || []).map(sanitizeDecisionEvent),
    learning_prompts: (feed.learning_prompts || []).map((prompt) => cleanString(prompt, 240)),
    data_quality: {
      trade_history_scope: cleanString(feed.data_quality?.trade_history_scope, 300),
      public_redaction:
        "Published feed contains only customer_public redacted fields approved by the connector.",
    },
  };

  assertNoForbiddenPublicKeys(snapshot);
  return {
    ...snapshot,
    content_hash: contentHash(snapshot),
  };
}

export function assertNoForbiddenPublicKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPublicKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
      throw new Error(`Forbidden public key ${path}.${key} would leak private broker data.`);
    }
    assertNoForbiddenPublicKeys(item, `${path}.${key}`);
  }
}

export function sanitizePublicFeedResponse(payload) {
  const response = payload && typeof payload === "object" ? payload : {};
  assertNoForbiddenPublicKeys(response);
  return response;
}

function sanitizePortfolioContext(portfolio) {
  if (!portfolio || typeof portfolio !== "object") {
    return null;
  }

  return {
    provider: portfolio.provider,
    fetched_at: portfolio.fetched_at,
    totals: portfolio.totals
      ? {
          holdings_count: portfolio.totals.holdings_count,
          open_net_positions_count: portfolio.totals.open_net_positions_count,
          total_holding_value_band: portfolio.totals.total_holding_value_band,
          total_holding_pnl_band: portfolio.totals.total_holding_pnl_band,
          net_position_pnl_band: portfolio.totals.net_position_pnl_band,
        }
      : undefined,
    holdings: (portfolio.holdings || []).map((holding) => ({
      symbol: cleanString(holding.symbol, 32),
      exchange: cleanString(holding.exchange, 16),
      product: cleanString(holding.product, 16),
      allocation_pct: safeNumber(holding.allocation_pct),
      quantity_band: cleanString(holding.quantity_band, 32),
      market_value_band: cleanString(holding.market_value_band, 32),
      pnl_band: cleanString(holding.pnl_band, 32),
      day_change_percentage: safeNumber(holding.day_change_percentage),
      discrepancy: Boolean(holding.discrepancy),
    })),
    positions: {
      net: sanitizePositions(portfolio.positions?.net),
      day: sanitizePositions(portfolio.positions?.day),
    },
  };
}

function sanitizePositions(positions = []) {
  return positions.map((position) => ({
    bucket: cleanString(position.bucket, 16),
    symbol: cleanString(position.symbol, 32),
    exchange: cleanString(position.exchange, 16),
    product: cleanString(position.product, 16),
    side: cleanString(position.side, 8),
    quantity_band: cleanString(position.quantity_band, 32),
    market_value_band: cleanString(position.market_value_band, 32),
    pnl_band: cleanString(position.pnl_band, 32),
  }));
}

function sanitizeDecisionEvent(event) {
  return {
    type: cleanString(event.type, 32),
    timestamp: cleanString(event.timestamp, 40),
    symbol: cleanString(event.symbol, 32),
    exchange: cleanString(event.exchange, 16),
    side: cleanString(event.side, 8),
    product: cleanString(event.product, 16),
    order_type: cleanString(event.order_type, 16),
    status: cleanString(event.status, 32),
    tag: cleanString(event.tag, 80),
    quantity_band: cleanString(event.quantity_band || event.quantity, 32),
    execution_price_band: cleanString(event.execution_price_band || event.execution_price, 32),
    learning_angle: cleanString(event.learning_angle, 80),
  };
}

function cleanString(value, maxLength) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).slice(0, maxLength);
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentHash(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
