export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Bindings {
  DB: D1Database;
  POST_LIMITER?: RateLimiter;
  APP_ORIGIN: string;
  ALLOWED_ORIGINS: string;
  ID_ORIGIN: string;
  ADMIN_EMAILS?: string;
  // GitHub Discussions projection. The route does not exist until the secret is set.
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_WEBHOOK_SECRET_PREVIOUS?: string;
  GITHUB_REPO?: string;
  GITHUB_REPO_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  // Reconcile job: runs only when all three of the app id, its private key and the installation are set.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_RECONCILE_DAYS?: string;
  // The feedback worker's public feed the forum mirrors; nothing is pulled until the token is set.
  FEEDBACK_PUBLIC_URL?: string;
  FEEDBACK_PUBLIC_TOKEN?: string;
}

// A signed-in forum member, resolved from the shared identity + local state.
export interface Member {
  email: string;
  handle: string;
  emailVerified: boolean;
  trust: number; // 0 new · 1 basic · 2 member · 3 regular · 4 leader
  role: "member" | "moderator" | "admin";
  silencedUntil: string | null;
}

export type AppEnv = { Bindings: Bindings; Variables: { member: Member | null } };
