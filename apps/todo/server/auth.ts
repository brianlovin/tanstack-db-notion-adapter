import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { NotionSyncAuthorizer } from "tanstack-db-notion-adapter/server";
import type { TodoEnvironment } from "./environment";

const cookieName = "daylight_session";
const sessionLifetimeSeconds = 60 * 60 * 24 * 30;

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sign(expiry: number, secret: string): string {
  const payload = String(expiry);
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function hasValidSession(request: Request, secret: string): boolean {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!cookie) return false;
  const [expiryText, signature] = cookie.split(".");
  const expiry = Number(expiryText);
  if (!expiryText || !signature || !Number.isSafeInteger(expiry)) return false;
  if (expiry <= Math.floor(Date.now() / 1_000)) return false;
  return equalSecret(signature, sign(expiry, secret).split(".")[1]!);
}

export interface TodoAuth {
  bypassed: boolean;
  authorize: NotionSyncAuthorizer;
  session: (context: Context) => Response;
  login: (context: Context) => Promise<Response>;
  logout: (context: Context) => Response;
}

export function createTodoAuth(environment: TodoEnvironment): TodoAuth {
  if (environment.mode === "production" && environment.devBypassAuth) {
    throw new Error("DEV_BYPASS_AUTH is forbidden in production.");
  }
  if (!environment.devBypassAuth && (!environment.appPassword || !environment.sessionSecret)) {
    throw new Error("APP_PASSWORD and SESSION_SECRET are required when authentication is enabled.");
  }

  const isAuthorized = (request: Request): boolean => {
    if (environment.devBypassAuth) return true;
    return hasValidSession(request, environment.sessionSecret!);
  };
  const authorize: NotionSyncAuthorizer = (request) => {
    if (environment.devBypassAuth) return true;
    if (!isAuthorized(request)) return false;
    if (request.method === "GET" || request.method === "HEAD") return true;
    return request.headers.get("origin") === environment.webOrigin;
  };

  return {
    bypassed: environment.devBypassAuth,
    authorize,
    session(context) {
      return context.json({
        authenticated: isAuthorized(context.req.raw),
        developmentBypass: environment.devBypassAuth,
      });
    },
    async login(context) {
      const contentLength = Number(context.req.header("content-length") ?? 0);
      if (contentLength > 8_192) {
        return context.json({ error: "Request too large." }, 413);
      }
      const text = await context.req.text();
      if (text.length > 8_192) {
        return context.json({ error: "Request too large." }, 413);
      }
      let password = "";
      try {
        const body = JSON.parse(text) as { password?: unknown };
        if (typeof body.password === "string") password = body.password;
      } catch {
        return context.json({ error: "Enter a valid password." }, 400);
      }
      if (!environment.appPassword || !equalSecret(password, environment.appPassword)) {
        return context.json({ error: "That password is not correct." }, 401);
      }

      const expiry = Math.floor(Date.now() / 1_000) + sessionLifetimeSeconds;
      setCookie(context, cookieName, sign(expiry, environment.sessionSecret!), {
        httpOnly: true,
        sameSite: "Strict",
        secure: environment.mode === "production",
        path: "/",
        maxAge: sessionLifetimeSeconds,
      });
      return context.json({ authenticated: true, developmentBypass: false });
    },
    logout(context) {
      deleteCookie(context, cookieName, { path: "/" });
      return context.json({ authenticated: false, developmentBypass: false });
    },
  };
}
