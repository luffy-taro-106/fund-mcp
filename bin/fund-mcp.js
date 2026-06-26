#!/usr/bin/env node

import {
  buildLoginUrl,
  KITE_API_ORIGIN,
  sanitizeSessionProfile,
  ZerodhaApiError,
  ZerodhaClient,
} from "../src/zerodha-client.js";
import { HushhApiClient, HushhApiError } from "../src/hushh-api-client.js";
import { buildPublishedLearningSnapshot } from "../src/published-feed.js";
import { readSession, resolveSessionPath, writeSession } from "../src/session-store.js";
import { jsonToolError, jsonToolResult } from "../src/tool-result.js";

const packageVersion = "0.1.0";
const packageName = "fund-mcp";
const args = process.argv.slice(2);
const validModes = new Set(["private_ingest", "public_learning"]);

function printUsage() {
  console.log(`${packageName} ${packageVersion}`);
  console.log("");
  console.log("Read-only Zerodha Kite MCP connector for portfolio and decision-learning workflows.");
  console.log("");
  console.log("Usage:");
  console.log("  fund-mcp");
  console.log("  fund-mcp --print-config");
  console.log("  fund-mcp --print-public-config");
  console.log("  fund-mcp --print-codex-toml");
  console.log("  fund-mcp --print-public-codex-toml");
  console.log("");
  console.log("Environment:");
  console.log("  HUSHH_ZERODHA_MCP_MODE  private_ingest or public_learning");
  console.log("  ZERODHA_API_KEY       Required Kite Connect app API key");
  console.log("  ZERODHA_API_SECRET    Required only for request_token exchange");
  console.log("  ZERODHA_ACCESS_TOKEN  Optional daily access token");
  console.log("  ZERODHA_SESSION_PATH  Optional local 0600 session cache path");
  console.log("  ZERODHA_API_ORIGIN    Optional Kite API origin override for tests/proxies");
  console.log("  HUSHH_API_URL         Required for Hushh publish/public proxy tools");
  console.log("  HUSHH_INGEST_TOKEN    Required for private_ingest snapshot publishing");
  console.log("  HUSHH_LEARNING_FEED_TOKEN  Required for public_learning feed reads");
  console.log("  HUSHH_CREATOR_ID      Optional default creator/feed id");
}

function printConfig() {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "hushh-zerodha": {
            command: "npx",
            args: ["-y", packageName],
            env: {
              HUSHH_ZERODHA_MCP_MODE: "private_ingest",
              ZERODHA_API_KEY: "<kite-api-key>",
              ZERODHA_API_SECRET: "<kite-api-secret>",
              ZERODHA_ACCESS_TOKEN: "<daily-access-token-optional>",
              HUSHH_API_URL: "https://api.hushh.ai",
              HUSHH_INGEST_TOKEN: "<hushh-private-ingest-token>",
              HUSHH_CREATOR_ID: "<creator-id>",
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function printPublicConfig() {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "hushh-zerodha-learning": {
            command: "npx",
            args: ["-y", packageName],
            env: {
              HUSHH_ZERODHA_MCP_MODE: "public_learning",
              HUSHH_API_URL: "https://api.hushh.ai",
              HUSHH_LEARNING_FEED_TOKEN: "<hushh-learning-feed-token>",
              HUSHH_CREATOR_ID: "<creator-id>",
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function printCodexToml() {
  console.log("[mcp_servers.hushh_zerodha]");
  console.log('command = "npx"');
  console.log(`args = ["-y", "${packageName}"]`);
  console.log("enabled = true");
  console.log("[mcp_servers.hushh_zerodha.env]");
  console.log('HUSHH_ZERODHA_MCP_MODE = "private_ingest"');
  console.log('ZERODHA_API_KEY = "<kite-api-key>"');
  console.log('ZERODHA_API_SECRET = "<kite-api-secret>"');
  console.log('ZERODHA_ACCESS_TOKEN = "<daily-access-token-optional>"');
  console.log('HUSHH_API_URL = "https://api.hushh.ai"');
  console.log('HUSHH_INGEST_TOKEN = "<hushh-private-ingest-token>"');
  console.log('HUSHH_CREATOR_ID = "<creator-id>"');
}

function printPublicCodexToml() {
  console.log("[mcp_servers.hushh_zerodha_learning]");
  console.log('command = "npx"');
  console.log(`args = ["-y", "${packageName}"]`);
  console.log("enabled = true");
  console.log("[mcp_servers.hushh_zerodha_learning.env]");
  console.log('HUSHH_ZERODHA_MCP_MODE = "public_learning"');
  console.log('HUSHH_API_URL = "https://api.hushh.ai"');
  console.log('HUSHH_LEARNING_FEED_TOKEN = "<hushh-learning-feed-token>"');
  console.log('HUSHH_CREATOR_ID = "<creator-id>"');
}

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

if (args.includes("--print-config")) {
  printConfig();
  process.exit(0);
}

if (args.includes("--print-public-config")) {
  printPublicConfig();
  process.exit(0);
}

if (args.includes("--print-codex-toml")) {
  printCodexToml();
  process.exit(0);
}

if (args.includes("--print-public-codex-toml")) {
  printPublicCodexToml();
  process.exit(0);
}

const [{ McpServer }, { StdioServerTransport }, zodModule] = await Promise.all([
  import("@modelcontextprotocol/sdk/server/mcp.js"),
  import("@modelcontextprotocol/sdk/server/stdio.js"),
  import("zod/v4"),
]);
const { z } = zodModule;
const mcpMode = resolveMode();

function errorMessage(error) {
  if (error instanceof ZerodhaApiError || error instanceof HushhApiError) {
    return {
      message: error.message,
      status: error.status,
      error_type: error.errorType,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function resolveMode() {
  const mode = process.env.HUSHH_ZERODHA_MCP_MODE || "private_ingest";
  if (!validModes.has(mode)) {
    process.stderr.write(
      `[fund-mcp] Invalid HUSHH_ZERODHA_MCP_MODE: ${mode}. Use private_ingest or public_learning.\n`,
    );
    process.exit(1);
  }
  return mode;
}

function resolveCreatorId(value) {
  const creatorId = value || process.env.HUSHH_CREATOR_ID;
  if (!creatorId) {
    throw new Error("creator_id or HUSHH_CREATOR_ID is required.");
  }
  return creatorId;
}

async function makeClient({ requireAccessToken = true } = {}) {
  const sessionPath = resolveSessionPath(process.env.ZERODHA_SESSION_PATH);
  const session = await readSession(sessionPath);
  const apiKey = process.env.ZERODHA_API_KEY || session?.api_key;
  const accessToken = process.env.ZERODHA_ACCESS_TOKEN || session?.access_token;

  if (!apiKey) {
    throw new Error("ZERODHA_API_KEY is required.");
  }
  if (requireAccessToken && !accessToken) {
    throw new Error(
      "ZERODHA_ACCESS_TOKEN is required. Generate one through the Zerodha login flow or call hushh_zerodha_exchange_request_token.",
    );
  }

  return {
    client: new ZerodhaClient({
      apiKey,
      apiSecret: process.env.ZERODHA_API_SECRET,
      accessToken,
      apiOrigin: process.env.ZERODHA_API_ORIGIN || KITE_API_ORIGIN,
    }),
    apiKey,
    sessionPath,
  };
}

function makeHushhApiClient(tokenEnvName) {
  return new HushhApiClient({
    apiUrl: process.env.HUSHH_API_URL,
    token: process.env[tokenEnvName],
  });
}

function registerJsonTool(server, name, config, handler) {
  server.registerTool(name, config, async (input) => {
    try {
      const payload = await handler(input);
      return jsonToolResult(payload);
    } catch (error) {
      const details = errorMessage(error);
      return jsonToolError(details.message, {
        provider: "zerodha",
        status: details.status,
        error_type: details.error_type,
        safety_note:
          "No credentials or access tokens are returned by this MCP. Check local env/session configuration.",
      });
    }
  });
}

const redactionSchema = z.enum(["customer_public", "private"]).default("customer_public");

const server = new McpServer(
  {
    name: "fund-mcp",
    version: packageVersion,
  },
  {
    instructions:
      mcpMode === "public_learning"
        ? "Customer-facing Hushh learning MCP. This mode cannot call Zerodha and only reads redacted feeds from Hushh API."
        : "Private Hushh Zerodha ingestion MCP. Keep this mode owner-only. Use customer_public redaction before publishing. Do not use this server for trade placement, copy-trading, or personalized financial advice.",
  },
);

function registerPrivateIngestTools() {
registerJsonTool(
  server,
  "hushh_zerodha_login_url",
  {
    title: "Zerodha Login URL",
    description:
      "Build the Kite Connect login URL for the configured API key. This does not call Zerodha.",
    inputSchema: z.object({
      redirect_params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Optional state values that Zerodha will return to your redirect URL."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ redirect_params: redirectParams } = {}) => {
    const apiKey = process.env.ZERODHA_API_KEY;
    if (!apiKey) {
      throw new Error("ZERODHA_API_KEY is required to build a login URL.");
    }
    return {
      ok: true,
      login_url: buildLoginUrl({ apiKey, redirectParams }),
      next_step:
        "Open this URL outside the MCP, complete Zerodha login, then pass the returned request_token to hushh_zerodha_exchange_request_token.",
      secret_handling:
        "Do not paste ZERODHA_API_SECRET or access_token into a chat transcript. Keep them in local env or a product vault.",
    };
  },
);

registerJsonTool(
  server,
  "hushh_zerodha_exchange_request_token",
  {
    title: "Exchange Zerodha Request Token",
    description:
      "Exchange a Zerodha request_token for an access token and store it locally with 0600 permissions. This returns no access token to the MCP host.",
    inputSchema: z.object({
      request_token: z.string().min(8),
      persist_session: z.boolean().default(true),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ request_token: requestToken, persist_session: persistSession = true }) => {
    const { client, apiKey, sessionPath } = await makeClient({ requireAccessToken: false });
    const session = await client.exchangeRequestToken(requestToken);
    const safeProfile = sanitizeSessionProfile(session);

    let persistedTo;
    if (persistSession) {
      persistedTo = await writeSession(sessionPath, {
        api_key: apiKey,
        access_token: session.access_token,
        user_id: session.user_id,
        broker: session.broker,
        login_time: session.login_time,
        created_at: new Date().toISOString(),
      });
    }

    return {
      ok: true,
      access_token_returned: false,
      persisted_session: Boolean(persistedTo),
      session_path: persistedTo,
      profile: safeProfile,
      expiry_note:
        "Kite access tokens are day-scoped. Refresh through the login flow when Zerodha expires the session.",
    };
  },
);

registerJsonTool(
  server,
  "hushh_zerodha_portfolio",
  {
    title: "Fetch Zerodha Portfolio",
    description:
      "Fetch read-only holdings and positions from Zerodha and return a redacted portfolio snapshot.",
    inputSchema: z.object({
      redaction: redactionSchema,
      include_profile: z.boolean().default(false),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ redaction, include_profile: includeProfile }) => {
    const { client } = await makeClient();
    return client.portfolioSnapshot({ redaction, includeProfile });
  },
);

registerJsonTool(
  server,
  "hushh_zerodha_recent_trade_logs",
  {
    title: "Fetch Zerodha Trade Logs",
    description:
      "Fetch the current trading day's read-only tradebook and optionally orderbook from Zerodha.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      include_orders: z.boolean().default(true),
      redaction: redactionSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ limit, include_orders: includeOrders, redaction }) => {
    const { client } = await makeClient();
    return client.recentTradeLogs({ limit, includeOrders, redaction });
  },
);

registerJsonTool(
  server,
  "hushh_zerodha_learning_feed",
  {
    title: "Build Zerodha Decision Learning Feed",
    description:
      "Combine portfolio context and recent trade/order events into an educational, non-advisory decision journal.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      include_portfolio: z.boolean().default(true),
      redaction: redactionSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ limit, include_portfolio: includePortfolio, redaction }) => {
    const { client } = await makeClient();
    return client.learningFeed({ limit, includePortfolio, redaction });
  },
);

registerJsonTool(
  server,
  "hushh_zerodha_publish_learning_snapshot",
  {
    title: "Publish Redacted Zerodha Learning Snapshot",
    description:
      "Fetch Zerodha privately, convert to a customer_public decision-learning snapshot, and publish only that redacted snapshot to Hushh API.",
    inputSchema: z.object({
      creator_id: z.string().min(1).optional(),
      title: z.string().max(120).default("Zerodha decision journal"),
      visibility: z.enum(["private", "subscribers", "public"]).default("subscribers"),
      limit: z.number().int().min(1).max(50).default(10),
      include_portfolio: z.boolean().default(true),
      return_snapshot: z.boolean().default(false),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({
    creator_id: creatorIdInput,
    title,
    visibility,
    limit,
    include_portfolio: includePortfolio,
    return_snapshot: returnSnapshot,
  }) => {
    const creatorId = resolveCreatorId(creatorIdInput);
    const { client } = await makeClient();
    const hushhApi = makeHushhApiClient("HUSHH_INGEST_TOKEN");
    const feed = await client.learningFeed({
      limit,
      includePortfolio,
      redaction: "customer_public",
    });
    const snapshot = buildPublishedLearningSnapshot({
      creatorId,
      feed,
      title,
      visibility,
    });
    const publishResult = await hushhApi.publishLearningSnapshot(snapshot);

    return {
      ok: true,
      provider: "hushh",
      source_provider: "zerodha",
      published: publishResult,
      content_hash: snapshot.content_hash,
      decision_event_count: snapshot.decision_events.length,
      portfolio_context_included: Boolean(snapshot.portfolio_context),
      snapshot_returned: Boolean(returnSnapshot),
      snapshot: returnSnapshot ? snapshot : undefined,
      boundary:
        "Only the customer_public snapshot was sent to Hushh API. Zerodha credentials, access tokens, order ids, trade ids, exact quantities, exact prices, exact P&L, and account identifiers are not published.",
    };
  },
);
}

function registerPublicLearningTools() {
  registerJsonTool(
    server,
    "hushh_public_zerodha_learning_feed",
    {
      title: "Fetch Public Zerodha Learning Feed",
      description:
        "Fetch the customer-facing Zerodha decision-learning feed from Hushh API. This tool cannot call Zerodha.",
      inputSchema: z.object({
        creator_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ creator_id: creatorIdInput, limit }) => {
      const creatorId = resolveCreatorId(creatorIdInput);
      const hushhApi = makeHushhApiClient("HUSHH_LEARNING_FEED_TOKEN");
      return hushhApi.fetchPublicLearningFeed({ creatorId, limit });
    },
  );
}

if (mcpMode === "public_learning") {
  registerPublicLearningTools();
} else {
  registerPrivateIngestTools();
}

server.registerResource(
  "zerodha_product_boundary",
  "zerodha://info/product-boundary",
  {
    title: "Zerodha MCP Product Boundary",
    description: "Read-only, consent-first product constraints for the Hushh Zerodha MCP.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            provider: "zerodha",
            mcp_mode: mcpMode,
            mode: mcpMode === "public_learning" ? "hushh_api_public_proxy" : "private_read_only_ingest",
            supported_endpoints: [
              ...(mcpMode === "public_learning"
                ? ["/api/learning/creators/{creator_id}/zerodha/feed"]
                : [
                    "/user/profile",
                    "/portfolio/holdings",
                    "/portfolio/positions",
                    "/orders",
                    "/trades",
                    "/api/zerodha/learning-snapshots",
                  ]),
            ],
            prohibited_capabilities: [
              "order placement",
              "order modification",
              "order cancellation",
              "GTT creation",
              "fund transfer",
              "personalized financial advice",
            ],
            customer_learning_boundary:
              "Customer-facing MCP instances must run HUSHH_ZERODHA_MCP_MODE=public_learning so they can only access Hushh-published redacted snapshots, not live Zerodha credentials or raw broker data.",
          },
          null,
          2,
        ),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
