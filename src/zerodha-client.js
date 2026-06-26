import crypto from "node:crypto";

export const KITE_API_ORIGIN = "https://api.kite.trade";
export const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login";

const VALID_REDACTION_MODES = new Set(["customer_public", "private"]);
const MAX_LIMIT = 50;

export class ZerodhaApiError extends Error {
  constructor(message, options = {}) {
    super(redactSensitiveText(message));
    this.name = "ZerodhaApiError";
    this.status = options.status;
    this.errorType = options.errorType;
  }
}

export function computeChecksum({ apiKey, requestToken, apiSecret }) {
  assertNonEmpty(apiKey, "ZERODHA_API_KEY");
  assertNonEmpty(requestToken, "request_token");
  assertNonEmpty(apiSecret, "ZERODHA_API_SECRET");
  return crypto
    .createHash("sha256")
    .update(`${apiKey}${requestToken}${apiSecret}`)
    .digest("hex");
}

export function buildLoginUrl({ apiKey, redirectParams = {} }) {
  assertNonEmpty(apiKey, "ZERODHA_API_KEY");
  const url = new URL(KITE_LOGIN_URL);
  url.searchParams.set("v", "3");
  url.searchParams.set("api_key", apiKey);

  const params = normalizeRedirectParams(redirectParams);
  if (params) {
    url.searchParams.set("redirect_params", params);
  }

  return url.toString();
}

export function clampLimit(value, fallback = 10, max = MAX_LIMIT) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

export function sanitizeSessionProfile(data) {
  if (!data || typeof data !== "object") {
    return {};
  }
  return {
    user_id: data.user_id,
    user_name: data.user_name,
    user_shortname: data.user_shortname,
    email: maskEmail(data.email),
    broker: data.broker,
    exchanges: Array.isArray(data.exchanges) ? data.exchanges : [],
    products: Array.isArray(data.products) ? data.products : [],
    order_types: Array.isArray(data.order_types) ? data.order_types : [],
    login_time: data.login_time,
  };
}

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/(token\s+)[a-zA-Z0-9:_-]+/gi, "$1[redacted]")
    .replace(/(api_secret=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[a-zA-Z0-9_-]{24,}/g, "[redacted]");
}

export class ZerodhaClient {
  constructor({
    apiKey,
    apiSecret,
    accessToken,
    apiOrigin = KITE_API_ORIGIN,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.accessToken = accessToken;
    this.apiOrigin = String(apiOrigin || KITE_API_ORIGIN).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("A fetch implementation is required. Use Node 18.18+ or pass fetchImpl.");
    }
  }

  async exchangeRequestToken(requestToken) {
    const checksum = computeChecksum({
      apiKey: this.apiKey,
      requestToken,
      apiSecret: this.apiSecret,
    });
    const data = await this.request("/session/token", {
      method: "POST",
      auth: false,
      form: {
        api_key: this.apiKey,
        request_token: requestToken,
        checksum,
      },
    });
    if (!data || typeof data.access_token !== "string") {
      throw new ZerodhaApiError("Zerodha did not return an access token.");
    }
    this.accessToken = data.access_token;
    return data;
  }

  async profile() {
    return this.request("/user/profile");
  }

  async holdings() {
    return this.request("/portfolio/holdings");
  }

  async positions() {
    return this.request("/portfolio/positions");
  }

  async orders() {
    return this.request("/orders");
  }

  async trades() {
    return this.request("/trades");
  }

  async portfolioSnapshot({ includeProfile = false, redaction = "customer_public" } = {}) {
    const mode = normalizeRedaction(redaction);
    const calls = [this.holdings(), this.positions()];
    if (includeProfile) {
      calls.push(this.profile());
    }

    const [holdings, positions, profile] = await Promise.all(calls);
    return buildPortfolioSnapshot({
      holdings: Array.isArray(holdings) ? holdings : [],
      positions: normalizePositionsEnvelope(positions),
      profile: includeProfile ? sanitizeSessionProfile(profile) : undefined,
      redaction: mode,
    });
  }

  async recentTradeLogs({
    limit = 10,
    includeOrders = true,
    redaction = "customer_public",
  } = {}) {
    const mode = normalizeRedaction(redaction);
    const boundedLimit = clampLimit(limit);
    const [trades, orders] = await Promise.all([
      this.trades(),
      includeOrders ? this.orders() : Promise.resolve([]),
    ]);
    return buildRecentTradeLogs({
      trades: Array.isArray(trades) ? trades : [],
      orders: Array.isArray(orders) ? orders : [],
      limit: boundedLimit,
      includeOrders,
      redaction: mode,
    });
  }

  async learningFeed({
    limit = 10,
    includePortfolio = true,
    redaction = "customer_public",
  } = {}) {
    const mode = normalizeRedaction(redaction);
    const boundedLimit = clampLimit(limit);
    const [portfolio, tradeLogs] = await Promise.all([
      includePortfolio ? this.portfolioSnapshot({ redaction: mode }) : Promise.resolve(null),
      this.recentTradeLogs({
        limit: boundedLimit,
        includeOrders: true,
        redaction: mode,
      }),
    ]);

    return buildLearningFeed({
      portfolio,
      tradeLogs,
      limit: boundedLimit,
      redaction: mode,
    });
  }

  async request(path, { method = "GET", auth = true, form, body } = {}) {
    if (auth) {
      assertNonEmpty(this.apiKey, "ZERODHA_API_KEY");
      assertNonEmpty(this.accessToken, "ZERODHA_ACCESS_TOKEN");
    }

    const headers = {
      "X-Kite-Version": "3",
      Accept: "application/json",
    };
    const requestOptions = { method, headers };

    if (auth) {
      headers.Authorization = `token ${this.apiKey}:${this.accessToken}`;
    }

    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      requestOptions.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.apiOrigin}${path}`, requestOptions);
    const raw = await response.text();
    const parsed = parseJson(raw);

    if (!response.ok || parsed?.status === "error") {
      throw new ZerodhaApiError(parsed?.message || `Zerodha API error ${response.status}`, {
        status: response.status,
        errorType: parsed?.error_type,
      });
    }

    return parsed?.data ?? parsed;
  }
}

export function buildPortfolioSnapshot({ holdings, positions, profile, redaction }) {
  const normalizedHoldings = holdings.map(normalizeHolding);
  const normalizedNetPositions = positions.net.map((position) => normalizePosition(position, "net"));
  const normalizedDayPositions = positions.day.map((position) => normalizePosition(position, "day"));
  const totalHoldingValue = sum(normalizedHoldings.map((holding) => holding.market_value));
  const totalHoldingPnl = sum(normalizedHoldings.map((holding) => holding.pnl));
  const netPositionPnl = sum(normalizedNetPositions.map((position) => position.pnl));

  const publicHoldings = normalizedHoldings
    .sort((left, right) => Math.abs(right.market_value) - Math.abs(left.market_value))
    .map((holding) => redactHolding(holding, redaction, totalHoldingValue));
  const publicNetPositions = normalizedNetPositions.map((position) => redactPosition(position, redaction));
  const publicDayPositions = normalizedDayPositions.map((position) => redactPosition(position, redaction));

  return {
    ok: true,
    provider: "zerodha",
    fetched_at: new Date().toISOString(),
    redaction,
    profile,
    totals:
      redaction === "private"
        ? {
            holdings_count: normalizedHoldings.length,
            open_net_positions_count: normalizedNetPositions.filter((position) => position.quantity !== 0)
              .length,
            total_holding_value: round(totalHoldingValue),
            total_holding_pnl: round(totalHoldingPnl),
            net_position_pnl: round(netPositionPnl),
          }
        : {
            holdings_count: normalizedHoldings.length,
            open_net_positions_count: normalizedNetPositions.filter((position) => position.quantity !== 0)
              .length,
            total_holding_value_band: currencyBand(totalHoldingValue),
            total_holding_pnl_band: currencyBand(totalHoldingPnl),
            net_position_pnl_band: currencyBand(netPositionPnl),
          },
    holdings: publicHoldings,
    positions: {
      net: publicNetPositions,
      day: publicDayPositions,
    },
    data_boundary: {
      mode: "read_only",
      endpoints: ["/portfolio/holdings", "/portfolio/positions"],
      public_mode_note:
        redaction === "customer_public"
          ? "Exact quantities, prices, order identifiers, and account identifiers are bucketed or omitted."
          : "Private mode keeps broker-returned numeric fields for the account owner or a consented internal workflow.",
    },
  };
}

export function buildRecentTradeLogs({ trades, orders, limit, includeOrders, redaction }) {
  const ordersById = new Map(orders.map((order) => [String(order.order_id), normalizeOrder(order)]));
  const normalizedTrades = trades
    .map((trade) => normalizeTrade(trade, ordersById.get(String(trade.order_id))))
    .sort(compareByTimestampDesc);
  const normalizedOrders = orders.map(normalizeOrder).sort(compareByTimestampDesc);

  return {
    ok: true,
    provider: "zerodha",
    fetched_at: new Date().toISOString(),
    redaction,
    scope_note:
      "Kite /trades and /orders expose the current trading day's tradebook and orderbook. Persist consented daily snapshots elsewhere if the product needs multi-day history.",
    counts: {
      returned_trades: Math.min(limit, normalizedTrades.length),
      available_trades: normalizedTrades.length,
      returned_orders: includeOrders ? Math.min(limit, normalizedOrders.length) : 0,
      available_orders: includeOrders ? normalizedOrders.length : 0,
    },
    trades: normalizedTrades.slice(0, limit).map((trade) => redactTrade(trade, redaction)),
    orders: includeOrders
      ? normalizedOrders.slice(0, limit).map((order) => redactOrder(order, redaction))
      : undefined,
    data_boundary: {
      mode: "read_only",
      endpoints: includeOrders ? ["/trades", "/orders"] : ["/trades"],
      public_mode_note:
        redaction === "customer_public"
          ? "Trade/order ids, exchange ids, exact prices, and exact quantities are removed or bucketed."
          : "Private mode includes broker-returned execution details for the account owner or a consented internal workflow.",
    },
  };
}

export function buildLearningFeed({ portfolio, tradeLogs, limit, redaction }) {
  const tradeEvents = tradeLogs.trades.map((trade) => ({
    type: "executed_trade",
    timestamp: trade.timestamp,
    symbol: trade.symbol,
    exchange: trade.exchange,
    side: trade.side,
    product: trade.product,
    order_type: trade.order_type,
    quantity: trade.quantity_band ?? trade.quantity,
    execution_price: trade.price_band ?? trade.price,
    tag: trade.tag,
    learning_angle: inferLearningAngleFromTrade(trade),
  }));

  const orderEvents = (tradeLogs.orders || [])
    .filter((order) => order.status && order.status !== "COMPLETE")
    .slice(0, limit)
    .map((order) => ({
      type: "order_state",
      timestamp: order.timestamp,
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      product: order.product,
      order_type: order.order_type,
      status: order.status,
      tag: order.tag,
      learning_angle: inferLearningAngleFromOrder(order),
    }));

  const decisionEvents = [...tradeEvents, ...orderEvents]
    .sort(compareByTimestampDesc)
    .slice(0, limit);

  return {
    ok: true,
    provider: "zerodha",
    fetched_at: new Date().toISOString(),
    redaction,
    product_boundary: {
      purpose: "educational_decision_journal",
      mode: "read_only",
      not_included: [
        "trade placement",
        "order modification",
        "order cancellation",
        "personalized financial advice",
        "copy-trading instructions",
      ],
      compliance_note:
        "Use this feed as historical context and founder decision education only. Do not present it as investment advice or a recommendation for another customer account.",
    },
    portfolio_snapshot: portfolio,
    decision_events: decisionEvents,
    learning_prompts: [
      "What changed in exposure before and after these actions?",
      "Which trades were tagged with a repeatable thesis or risk-control reason?",
      "Were rejected or cancelled orders caused by sizing, price discipline, or broker risk checks?",
      "Did today's actions increase concentration, reduce it, or leave it broadly unchanged?",
    ],
    data_quality: {
      trade_history_scope: tradeLogs.scope_note,
      public_redaction:
        redaction === "customer_public"
          ? "This output is suitable for a customer-facing learning feed only after product/legal review."
          : "This output includes private account details and should stay inside owner-approved workflows.",
    },
  };
}

function normalizeHolding(holding) {
  const quantity = toNumber(holding.quantity) + toNumber(holding.t1_quantity);
  const lastPrice = toNumber(holding.last_price);
  const marketValue = quantity * lastPrice;
  return {
    symbol: holding.tradingsymbol,
    exchange: holding.exchange,
    isin: holding.isin,
    product: holding.product,
    quantity,
    average_price: toNumber(holding.average_price),
    last_price: lastPrice,
    close_price: toNumber(holding.close_price),
    market_value: marketValue,
    pnl: toNumber(holding.pnl),
    day_change: toNumber(holding.day_change),
    day_change_percentage: toNumber(holding.day_change_percentage),
    collateral_quantity: toNumber(holding.collateral_quantity),
    discrepancy: Boolean(holding.discrepancy),
  };
}

function normalizePosition(position, bucket) {
  const quantity = toNumber(position.quantity);
  const multiplier = Math.max(1, toNumber(position.multiplier));
  const lastPrice = toNumber(position.last_price);
  return {
    bucket,
    symbol: position.tradingsymbol,
    exchange: position.exchange,
    product: position.product,
    quantity,
    overnight_quantity: toNumber(position.overnight_quantity),
    side: quantity > 0 ? "LONG" : quantity < 0 ? "SHORT" : "FLAT",
    average_price: toNumber(position.average_price),
    last_price: lastPrice,
    market_value: quantity * lastPrice * multiplier,
    pnl: toNumber(position.pnl),
    m2m: toNumber(position.m2m),
    multiplier,
  };
}

function normalizeOrder(order) {
  return {
    order_id: order.order_id,
    exchange_order_id: order.exchange_order_id,
    parent_order_id: order.parent_order_id,
    timestamp:
      order.exchange_timestamp ||
      order.exchange_update_timestamp ||
      order.order_timestamp ||
      order.created_at,
    symbol: order.tradingsymbol,
    exchange: order.exchange,
    side: order.transaction_type,
    product: order.product,
    variety: order.variety,
    order_type: order.order_type,
    validity: order.validity,
    status: order.status,
    status_message: order.status_message || order.status_message_raw,
    quantity: toNumber(order.quantity),
    filled_quantity: toNumber(order.filled_quantity),
    pending_quantity: toNumber(order.pending_quantity),
    cancelled_quantity: toNumber(order.cancelled_quantity),
    price: toNumber(order.price),
    average_price: toNumber(order.average_price),
    trigger_price: toNumber(order.trigger_price),
    tag: order.tag || (Array.isArray(order.tags) ? order.tags.join(",") : undefined),
  };
}

function normalizeTrade(trade, order) {
  return {
    trade_id: trade.trade_id,
    order_id: trade.order_id,
    exchange_order_id: trade.exchange_order_id,
    timestamp: trade.fill_timestamp || trade.exchange_timestamp || trade.order_timestamp,
    symbol: trade.tradingsymbol,
    exchange: trade.exchange,
    side: trade.transaction_type,
    product: trade.product,
    order_type: order?.order_type,
    variety: order?.variety,
    quantity: toNumber(trade.quantity),
    price: toNumber(trade.average_price),
    tag: order?.tag,
    order_status: order?.status,
  };
}

function redactHolding(holding, redaction, totalValue) {
  if (redaction === "private") {
    return {
      ...holding,
      average_price: round(holding.average_price),
      last_price: round(holding.last_price),
      close_price: round(holding.close_price),
      market_value: round(holding.market_value),
      pnl: round(holding.pnl),
      day_change: round(holding.day_change),
      day_change_percentage: round(holding.day_change_percentage),
    };
  }

  return {
    symbol: holding.symbol,
    exchange: holding.exchange,
    product: holding.product,
    allocation_pct: totalValue > 0 ? round((holding.market_value / totalValue) * 100) : 0,
    quantity_band: quantityBand(holding.quantity),
    market_value_band: currencyBand(holding.market_value),
    pnl_band: currencyBand(holding.pnl),
    day_change_percentage: round(holding.day_change_percentage),
    discrepancy: holding.discrepancy,
  };
}

function redactPosition(position, redaction) {
  if (redaction === "private") {
    return {
      ...position,
      average_price: round(position.average_price),
      last_price: round(position.last_price),
      market_value: round(position.market_value),
      pnl: round(position.pnl),
      m2m: round(position.m2m),
    };
  }

  return {
    bucket: position.bucket,
    symbol: position.symbol,
    exchange: position.exchange,
    product: position.product,
    side: position.side,
    quantity_band: quantityBand(Math.abs(position.quantity)),
    market_value_band: currencyBand(position.market_value),
    pnl_band: currencyBand(position.pnl),
  };
}

function redactTrade(trade, redaction) {
  if (redaction === "private") {
    return {
      ...trade,
      quantity: round(trade.quantity),
      price: round(trade.price),
    };
  }

  return {
    timestamp: trade.timestamp,
    symbol: trade.symbol,
    exchange: trade.exchange,
    side: trade.side,
    product: trade.product,
    order_type: trade.order_type,
    variety: trade.variety,
    quantity_band: quantityBand(trade.quantity),
    price_band: priceBand(trade.price),
    tag: trade.tag,
    order_status: trade.order_status,
  };
}

function redactOrder(order, redaction) {
  if (redaction === "private") {
    return {
      ...order,
      quantity: round(order.quantity),
      filled_quantity: round(order.filled_quantity),
      pending_quantity: round(order.pending_quantity),
      cancelled_quantity: round(order.cancelled_quantity),
      price: round(order.price),
      average_price: round(order.average_price),
      trigger_price: round(order.trigger_price),
      status_message: redactSensitiveText(order.status_message),
    };
  }

  return {
    timestamp: order.timestamp,
    symbol: order.symbol,
    exchange: order.exchange,
    side: order.side,
    product: order.product,
    variety: order.variety,
    order_type: order.order_type,
    validity: order.validity,
    status: order.status,
    status_message_summary: summarizeOrderStatus(order.status_message),
    quantity_band: quantityBand(order.quantity),
    filled_quantity_band: quantityBand(order.filled_quantity),
    price_band: priceBand(order.price),
    average_price_band: priceBand(order.average_price),
    tag: order.tag,
  };
}

function inferLearningAngleFromTrade(trade) {
  if (trade.tag) {
    return "tagged_decision";
  }
  if (trade.product && trade.product !== "CNC") {
    return "position_or_leverage_management";
  }
  if (trade.side === "SELL") {
    return "exit_or_risk_reduction";
  }
  if (trade.side === "BUY") {
    return "entry_or_accumulation";
  }
  return "execution_event";
}

function inferLearningAngleFromOrder(order) {
  if (order.status_message_summary) {
    return order.status_message_summary;
  }
  if (order.status === "CANCELLED") {
    return "cancelled_order_discipline";
  }
  if (order.status === "REJECTED") {
    return "broker_or_risk_rejection";
  }
  return "order_state_change";
}

function summarizeOrderStatus(message) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("margin") || normalized.includes("insufficient")) {
    return "margin_or_funds_check";
  }
  if (normalized.includes("rms") || normalized.includes("risk")) {
    return "broker_risk_check";
  }
  if (normalized.includes("circuit")) {
    return "price_circuit_check";
  }
  if (normalized.includes("market closed")) {
    return "market_timing_check";
  }
  return "broker_message_redacted";
}

function compareByTimestampDesc(left, right) {
  return timestampMs(right.timestamp) - timestampMs(left.timestamp);
}

function timestampMs(value) {
  if (!value) {
    return 0;
  }
  const normalized = String(value).replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePositionsEnvelope(positions) {
  return {
    net: Array.isArray(positions?.net) ? positions.net : [],
    day: Array.isArray(positions?.day) ? positions.day : [],
  };
}

function normalizeRedaction(value) {
  const normalized = value || "customer_public";
  if (!VALID_REDACTION_MODES.has(normalized)) {
    throw new Error(`Invalid redaction mode: ${normalized}`);
  }
  return normalized;
}

function normalizeRedirectParams(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) {
      params.set(key, String(item));
    }
  }
  return params.toString();
}

function parseJson(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + toNumber(value), 0);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function quantityBand(value) {
  return numericBand(Math.abs(toNumber(value)), [
    0,
    1,
    5,
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    5000,
    10000,
  ]);
}

function priceBand(value) {
  return `INR ${numericBand(Math.abs(toNumber(value)), [
    0,
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    2500,
    5000,
    10000,
    25000,
  ])}`;
}

function currencyBand(value) {
  const amount = Math.abs(toNumber(value));
  const sign = value < 0 ? "-" : "";
  if (amount === 0) {
    return "INR 0";
  }
  if (amount < 1000) {
    return `${sign}INR <1K`;
  }
  if (amount < 10000) {
    return `${sign}INR 1K-10K`;
  }
  if (amount < 50000) {
    return `${sign}INR 10K-50K`;
  }
  if (amount < 100000) {
    return `${sign}INR 50K-1L`;
  }
  if (amount < 500000) {
    return `${sign}INR 1L-5L`;
  }
  if (amount < 1000000) {
    return `${sign}INR 5L-10L`;
  }
  if (amount < 5000000) {
    return `${sign}INR 10L-50L`;
  }
  if (amount < 10000000) {
    return `${sign}INR 50L-1Cr`;
  }
  return `${sign}INR 1Cr+`;
}

function numericBand(value, thresholds) {
  const amount = Math.abs(toNumber(value));
  if (amount === 0) {
    return "0";
  }
  for (let index = 1; index < thresholds.length; index += 1) {
    const lower = thresholds[index - 1];
    const upper = thresholds[index];
    if (amount <= upper) {
      return lower === 0 ? `<=${upper}` : `${lower}-${upper}`;
    }
  }
  return `${thresholds[thresholds.length - 1]}+`;
}

function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return undefined;
  }
  const [local, domain] = email.split("@");
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function assertNonEmpty(value, label) {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required.`);
  }
}
