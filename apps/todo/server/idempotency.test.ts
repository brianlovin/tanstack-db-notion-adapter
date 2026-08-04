// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSqliteIdempotencyStore } from "./idempotency";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function stores() {
  const directory = await mkdtemp(join(tmpdir(), "daylight-ledger-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "idempotency.sqlite");
  return [createSqliteIdempotencyStore(path), createSqliteIdempotencyStore(path)] as const;
}

describe("SQLite idempotency ledger", () => {
  it("executes a concurrent key once across independent store instances", async () => {
    const [first, second] = await stores();
    let calls = 0;
    const operation = { scope: "source", key: "insert-1", fingerprint: "same" };
    const run = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { pageId: "page-1" };
    };

    const [left, right] = await Promise.all([
      first.execute(operation, run),
      second.execute(operation, run),
    ]);

    expect(calls).toBe(1);
    expect(left).toEqual({ pageId: "page-1" });
    expect(right).toEqual(left);
  });

  it("replays durable results and rejects a reused key with another payload", async () => {
    const [first, second] = await stores();
    const operation = { scope: "source", key: "insert-2", fingerprint: "one" };
    await first.execute(operation, async () => ({ ok: true }));
    let replayed = false;
    expect(
      await second.execute(operation, async () => {
        replayed = true;
        return { ok: false };
      }),
    ).toEqual({ ok: true });
    expect(replayed).toBe(false);
    await expect(
      second.execute({ ...operation, fingerprint: "two" }, async () => null),
    ).rejects.toThrow("different request payload");
  });

  it("releases failed executions so a retry can succeed", async () => {
    const [store] = await stores();
    const operation = { scope: "source", key: "update-1", fingerprint: "same" };
    await expect(
      store.execute(operation, async () => {
        throw new Error("lost");
      }),
    ).rejects.toThrow("lost");
    await expect(store.execute(operation, async () => "retried")).resolves.toBe("retried");
  });
});
