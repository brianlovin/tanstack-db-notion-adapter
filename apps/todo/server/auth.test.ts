// @vitest-environment node

import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { createTodoAuth } from "./auth";
import type { TodoEnvironment } from "./environment";

function environment(overrides: Partial<TodoEnvironment> = {}): TodoEnvironment {
  return {
    mode: "test",
    token: "pat",
    dataSourceId: "source",
    appPassword: "correct horse battery staple",
    sessionSecret: "a-long-test-session-secret-that-is-not-for-production",
    webhookVerificationToken: undefined,
    webOrigin: "https://tasks.example.com",
    port: 8790,
    devBypassAuth: false,
    dataDirectory: ".data-test",
    ...overrides,
  };
}

describe("Todo app authentication", () => {
  it("issues an HttpOnly strict session and authorizes same-origin writes", async () => {
    const auth = createTodoAuth(environment());
    const app = new Hono();
    app.post("/login", (context) => auth.login(context));
    const login = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    const cookie = login.headers.get("set-cookie")!;
    expect(login.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const allowed = new Request("https://tasks.example.com/api/todos", {
      method: "POST",
      headers: { cookie, origin: "https://tasks.example.com" },
    });
    const rejectedOrigin = new Request("https://tasks.example.com/api/todos", {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(await auth.authorize(allowed)).toBe(true);
    expect(await auth.authorize(rejectedOrigin)).toBe(false);
  });

  it("rejects a wrong password and forbids development bypass in production", async () => {
    const auth = createTodoAuth(environment());
    const app = new Hono();
    app.post("/login", (context) => auth.login(context));
    const response = await app.request("/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(response.status).toBe(401);
    expect(() => createTodoAuth(environment({ mode: "production", devBypassAuth: true }))).toThrow(
      "forbidden in production",
    );
  });
});
