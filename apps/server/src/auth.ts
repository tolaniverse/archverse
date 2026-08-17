import type { User } from "./domain";
import type { Store } from "./store";

export const SESSION_COOKIE = "archverse_session";
export const OAUTH_STATE_COOKIE = "archverse_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "archverse_oauth_verifier";

export type SecurityCookieNames = {
  session: string;
  state: string;
  verifier: string;
};

export function securityCookieNames(secure: boolean): SecurityCookieNames {
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}${SESSION_COOKIE}`,
    state: `${prefix}${OAUTH_STATE_COOKIE}`,
    verifier: `${prefix}${OAUTH_VERIFIER_COOKIE}`,
  };
}

export type AppConfig = {
  appUrl: string;
  webUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  secureCookies: boolean;
  openAiEnabled: boolean;
};

export type GithubClient = {
  exchangeCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<{ id: string; login: string; avatarUrl: string | null }>;
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64url(new Uint8Array(digest));
}

export function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name || seen.has(name)) {
      result.delete(name);
      seen.add(name);
      continue;
    }
    seen.add(name);
    try {
      result.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      result.delete(name);
    }
  }
  return result;
}

export function cookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAge}${options.secure ? "; Secure" : ""}`;
}

export function clearCookie(name: string, secure: boolean): string {
  return cookie(name, "", { maxAge: 0, secure });
}

export async function sessionUser(
  request: Request,
  store: Store,
  sessionCookie: string,
  now = new Date(),
): Promise<User | null> {
  const token = parseCookies(request).get(sessionCookie);
  if (!token) return null;
  return store.getUserBySessionHash(await sha256(token), now);
}

export class GithubOAuthClient implements GithubClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async exchangeCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<{ id: string; login: string; avatarUrl: string | null }> {
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: input.redirectUri,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const tokenBody = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new Error("GitHub token exchange failed");
    }

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenBody.access_token}`,
        "User-Agent": "Archverse",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const userBody = (await userResponse.json()) as {
      id?: number;
      login?: string;
      avatar_url?: string | null;
    };
    if (!userResponse.ok || !userBody.id || !userBody.login) {
      throw new Error("GitHub identity lookup failed");
    }
    return {
      id: String(userBody.id),
      login: userBody.login,
      avatarUrl: userBody.avatar_url ?? null,
    };
  }
}
