import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultSessionPath() {
  return path.join(os.homedir(), ".hushh", "zerodha-mcp", "session.json");
}

export function resolveSessionPath(value) {
  return path.resolve(value || process.env.ZERODHA_SESSION_PATH || defaultSessionPath());
}

export async function readSession(sessionPath = defaultSessionPath()) {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeSession(sessionPath, session) {
  const resolved = resolveSessionPath(sessionPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(resolved, 0o600);
  return resolved;
}
