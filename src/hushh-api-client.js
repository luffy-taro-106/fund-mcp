import { sanitizePublicFeedResponse } from "./published-feed.js";
import { redactSensitiveText } from "./zerodha-client.js";

export class HushhApiError extends Error {
  constructor(message, options = {}) {
    super(redactSensitiveText(message));
    this.name = "HushhApiError";
    this.status = options.status;
  }
}

export class HushhApiClient {
  constructor({ apiUrl, token, fetchImpl = globalThis.fetch } = {}) {
    if (!apiUrl || typeof apiUrl !== "string") {
      throw new Error("HUSHH_API_URL is required.");
    }
    if (!token || typeof token !== "string") {
      throw new Error("A Hushh API token is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required. Use Node 18.18+ or pass fetchImpl.");
    }
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async publishLearningSnapshot(snapshot) {
    return this.request("/api/zerodha/learning-snapshots", {
      method: "POST",
      body: snapshot,
    });
  }

  async fetchPublicLearningFeed({ creatorId, limit = 20 } = {}) {
    if (!creatorId || typeof creatorId !== "string") {
      throw new Error("creator_id is required.");
    }
    const url = new URL(`${this.apiUrl}/api/learning/creators/${encodeURIComponent(creatorId)}/zerodha/feed`);
    url.searchParams.set("limit", String(Math.max(1, Math.min(Number(limit) || 20, 50))));
    const payload = await this.request(url, { absoluteUrl: true });
    return sanitizePublicFeedResponse(payload);
  }

  async request(pathOrUrl, { method = "GET", body, absoluteUrl = false } = {}) {
    const url = absoluteUrl ? String(pathOrUrl) : `${this.apiUrl}${pathOrUrl}`;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    const options = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, options);
    const raw = await response.text();
    const parsed = parseJson(raw);

    if (!response.ok) {
      throw new HushhApiError(parsed?.error || parsed?.message || `Hushh API error ${response.status}`, {
        status: response.status,
      });
    }

    return parsed;
  }
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
