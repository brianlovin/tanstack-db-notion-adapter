import { useEffect, useState, useSyncExternalStore } from "react";
import type { NotionPageContentSnapshot, NotionSyncState } from "tanstack-db-notion-adapter";
import type { TodoWorkspace } from "./collection";

const serverSyncState: NotionSyncState = {
  status: "idle",
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: "memory",
  error: null,
  quarantine: null,
};

export function useNotionSyncState(workspace: TodoWorkspace): NotionSyncState {
  return useSyncExternalStore(
    workspace.collection.utils.subscribeSyncState,
    workspace.collection.utils.getSyncState,
    () => serverSyncState,
  );
}

export function useTaskContent(
  workspace: TodoWorkspace,
  key: string | null,
): NotionPageContentSnapshot | undefined {
  return useSyncExternalStore(
    workspace.content.subscribe,
    () => (key ? workspace.content.get(key) : undefined),
    () => undefined,
  );
}

export interface SessionState {
  authenticated: boolean;
  developmentBypass: boolean;
}

const rememberedSessionKey = "daylight:remembered-session";

function rememberSession(session: SessionState): void {
  if (session.authenticated) {
    localStorage.setItem(rememberedSessionKey, JSON.stringify(session));
  } else {
    localStorage.removeItem(rememberedSessionKey);
  }
}

function readRememberedSession(): SessionState | null {
  try {
    const value = localStorage.getItem(rememberedSessionKey);
    if (!value) return null;
    const session = JSON.parse(value) as Partial<SessionState>;
    if (session.authenticated !== true) return null;
    return {
      authenticated: true,
      developmentBypass: session.developmentBypass === true,
    };
  } catch {
    return null;
  }
}

export function useSession() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await fetch("/api/session");
      if (!response.ok) throw new Error("Session check failed.");
      const next = (await response.json()) as SessionState;
      rememberSession(next);
      setSession(next);
      setError(null);
    } catch (caught) {
      const remembered = readRememberedSession();
      if (caught instanceof TypeError && remembered) {
        setSession(remembered);
        setError(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Session check failed.");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const login = async (password: string) => {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await response.json()) as SessionState & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Sign in failed.");
    rememberSession(body);
    setSession(body);
  };
  const logout = async () => {
    const next = { authenticated: false, developmentBypass: false };
    try {
      await fetch("/api/session", { method: "DELETE" });
    } finally {
      rememberSession(next);
      setSession(next);
    }
  };

  return { session, error, login, logout, refresh };
}
