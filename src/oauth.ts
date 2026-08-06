import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getMachineId, getQoderMode, getQoderRefreshURL, isQoderCNMode } from "./cosy.js";
import { interactiveLogin } from "./login.js";
import { updateQoderModelsCache } from "./models.js";
import { credentialsFromPat, decodePatRefresh, isPatRefresh } from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

/** Return the PAT exposed through the environment for a provider mode. */
export function getQoderPatForMode(mode: string): string {
  if (isQoderCNMode(mode)) {
    return process.env.QODERCN_API_KEY || process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PAT || "";
  }
  return process.env.QODER_API_KEY || process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || "";
}

/** Exchange an environment PAT before omp resolves its initial model. */
export async function autoLoginQoderFromEnvironment(providerID: string, mode: string): Promise<void> {
  const pat = getQoderPatForMode(mode);
  if (!pat) return;

  // An explicitly supplied PAT is authoritative. The auth file only stores
  // the exchanged job token, so it cannot tell us whether the environment
  // token changed. Re-exchange it on startup to avoid silently using an old
  // account's credentials.
  const credentials = await credentialsFromPat(pat, mode);

  if (typeof AuthStorage !== "undefined" && typeof AuthStorage?.create === "function") {
    try {
      const authStorage = AuthStorage.create();
      authStorage.set(providerID, { type: "oauth", ...credentials });
    } catch {
      // AuthStorage unavailable — omp reads credentials from its own agent.db,
      // and the upstream ~/.pi/agent/auth.json fallback does not apply here.
    }
  }

  const qCreds = credentials as QoderCredentials;
  // Wait for the model cache before the provider is registered. This matters
  // for `pi --list-models`, which can exit before background work completes.
  await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode);
}

/**
 * Read the Qoder identity (userID/email/name/machineID) from omp's own auth
 * store. omp persists the full OAuthCredentials there on login/refresh and keeps
 * it up to date, so there is no need to maintain a separate credentials cache.
 *
 * Note: the auth.json path/shape is an omp internal convention, not a public API.
 * This is best-effort and falls back to null so callers can use placeholders.
 */
export function getCachedCredentials(_accessToken: string, providerID = "qoder"): QoderCredentials | null {
  // Try omp's agent.db (SQLite) — OMP stores credentials here
  const OMP_DB = join(homedir(), ".omp", "agent", "agent.db");
  if (existsSync(OMP_DB)) {
    try {
      // bun:sqlite is available at runtime when running inside omp (bun)
      const { Database } = require("bun:sqlite") as {
        Database: new (
          path: string,
        ) => {
          prepare: (sql: string) => { get: (...params: unknown[]) => { data?: string } };
          close: () => void;
        };
      };
      const db = new Database(OMP_DB);
      const row = db.prepare("SELECT data FROM auth_credentials WHERE provider = ?").get(providerID) as
        | { data?: string }
        | undefined;
      db.close();
      if (row && typeof row.data === "string") {
        const parsed = JSON.parse(row.data) as { access?: string; refresh?: string; email?: string };
        const access = parsed.access || "";
        const refresh = parsed.refresh || "";
        const email = parsed.email || "";
        if (refresh.startsWith("pat|")) {
          const parts = refresh.split("|");
          const userID = parts[3] || "";
          const machineID = parts[4] || "";
          const emailPart = parts[5] || "";
          const refreshEmail = emailPart.startsWith("email:") ? emailPart.slice(6) : "";
          if (userID) {
            return { access, refresh, userID, email: email || refreshEmail, name: "", machineID } as QoderCredentials;
          }
        }
      }
    } catch {}
  }

  return null;
}

async function loginQoderForMode(callbacks: OAuthLoginCallbacks, mode: string): Promise<OAuthCredentials> {
  // 1. Try environment variables first (PAT). A PAT (pt-...) must be exchanged
  //    for a short-lived job token before it can be used — credentialsFromPat
  //    handles the exchange + identity resolution.
  const pat = getQoderPatForMode(mode);
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, mode);
      const qCreds = creds as QoderCredentials;
      // omp persists these credentials in auth.json itself; no separate cache needed.
      // Cache models in background
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
      return creds;
    } catch {
      // Fall through to interactive login if PAT exchange fails.
    }
  }

  // 2. Interactive login (CN only supports PAT prompt here; global supports device flow fallback)
  const creds = await interactiveLogin(callbacks, mode);

  // Cache models in background. omp persists the credentials in auth.json itself.
  try {
    const qCreds = creds as QoderCredentials;
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
  } catch {}

  return creds;
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, getQoderMode());
}

export async function loginQoderCN(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, "cn");
}

export async function refreshQoderToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, getQoderMode());
}

export async function refreshQoderTokenCN(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, "cn");
}

async function refreshQoderTokenForMode(credentials: OAuthCredentials, mode: string): Promise<OAuthCredentials> {
  // PAT-based credentials: re-exchange the stored PAT for a fresh job token.
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (pat) {
      try {
        const refreshed = await credentialsFromPat(pat, mode);
        const qCreds = refreshed as QoderCredentials;
        updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
        return refreshed;
      } catch {
        // Fall through to validity extension below.
      }
    }
    return {
      ...credentials,
      expires: Date.now() + 60 * 60 * 1000, // extend 1 hour to retry later
    };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;
  const prevName = prev.name || "";
  const prevEmail = prev.email || "";

  const refreshURL = getQoderRefreshURL(mode);
  try {
    const response = await fetch(refreshURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "omp-provider-qoder",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };

      const newAccess = data.token;
      const newRefresh = data.refresh_token || refreshToken;

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      const refreshed = {
        ...credentials,
        refresh: `${newRefresh}|${userID}|${machineID}`,
        access: newAccess,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: prevEmail,
        name: prevName,
        machineID,
      };

      // omp persists the refreshed credentials in auth.json itself.
      // Cache models in background
      updateQoderModelsCache(newAccess, userID, prevName, prevEmail, mode).catch(() => {});

      return refreshed;
    }
  } catch {}

  // Fallback: Extend validity slightly to buy time, as Qoder tokens are long-lived
  const refreshedFallback = {
    ...credentials,
    expires: Date.now() + 60 * 60 * 1000, // extend for 1 hour
  };
  return refreshedFallback;
}
