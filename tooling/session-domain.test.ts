import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TOKEN_BYTES,
  hashPassword,
  issueSession,
  resolveSession,
  verifyPasswordCredential,
  revokeAllSessions,
  type AuditTransaction,
  type PasswordVerifier,
  type SessionPrincipal,
} from "../packages/domain/src/index.js";

const TENANT = "a1000000-0000-0000-0000-000000000001";
const USER = "a1000000-0000-0000-0001-000000000001";
const INSTANT = new Date("2027-03-01T09:00:00.000Z");

describe("session domain boundary", () => {
  it("issues an opaque high-entropy token while sending only its hash to persistence", async () => {
    const query = vi.fn(async (_text: string, values?: unknown[]) => ({
      rows: [
        {
          id: "a1000000-0000-0000-0002-000000000001",
          user_id: USER,
          issued_at: INSTANT,
          idle_expires_at: values?.[4],
          absolute_expires_at: values?.[5],
        },
      ],
    }));

    const issued = await issueSession({ query } as unknown as AuditTransaction, {
      tenantId: TENANT,
      userId: USER,
      userAgentClass: "browser",
      instant: INSTANT,
    });

    expect(Buffer.from(issued.token, "base64url")).toHaveLength(SESSION_TOKEN_BYTES);
    expect(issued).toMatchObject({ principal: { type: "USER", id: USER }, issuedAt: INSTANT });
    const values = query.mock.calls[0]?.[1] ?? [];
    expect(values).not.toContain(issued.token);
    expect(values[2]).toBe(
      `sha-256:${createHash("sha256").update(issued.token, "utf8").digest("hex")}`,
    );
  });

  it("INV-AUTH-014: resolves no identity when the freshly read user is not active", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "a1000000-0000-0000-0002-000000000001",
          user_id: USER,
          idle_expires_at: new Date("2027-03-01T10:00:00.000Z"),
          absolute_expires_at: new Date("2027-03-01T20:00:00.000Z"),
          user_status: "DEACTIVATED",
        },
      ],
    }));

    await expect(
      resolveSession({ query } as unknown as AuditTransaction, {
        tenantId: TENANT,
        token: "opaque-token",
        instant: INSTANT,
      }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("INV-AUTH-004: exposes identity without cached capabilities, grants or decisions", () => {
    type CachedAuthorityKey = Extract<
      keyof SessionPrincipal,
      "capabilities" | "grants" | "decision"
    >;
    const hasNoCachedAuthority: [CachedAuthorityKey] extends [never] ? true : false = true;

    expect(hasNoCachedAuthority).toBe(true);
  });

  it("INV-AUD-007: uses a verifier port and emits no governance event for a mismatch", async () => {
    const verifier: PasswordVerifier = {
      hash: vi.fn(async (secret: string) => ({
        secretHash: `fake:${secret}`,
        params: { algorithm: "fake", cost: 1 },
      })),
      verify: vi.fn(async () => false),
    };
    await expect(hashPassword(verifier, "correct horse battery staple")).resolves.toEqual({
      secretHash: "fake:correct horse battery staple",
      params: { algorithm: "fake", cost: 1 },
    });

    const query = vi.fn(async () => ({
      rows: [{ user_id: USER, secret_hash: "fake:stored", params: { algorithm: "fake" } }],
    }));
    await expect(
      verifyPasswordCredential({ query } as unknown as AuditTransaction, verifier, {
        tenantId: TENANT,
        contactEmail: "person@example.test",
        password: "incorrect",
      }),
    ).resolves.toBeNull();
    expect(verifier.verify).toHaveBeenCalledWith("incorrect", {
      secretHash: "fake:stored",
      params: { algorithm: "fake" },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("from app_user principal");
    expect(query.mock.calls[0]?.[0]).not.toContain("audit_event");
  });

  it("INV-AUTH-014: equalises the password work for an unavailable principal", async () => {
    const verifier: PasswordVerifier = {
      hash: vi.fn(async (secret: string) => ({
        secretHash: `fake:${secret}`,
        params: { algorithm: "fake" },
      })),
      verify: vi.fn(async () => false),
    };
    const query = vi.fn(async () => ({ rows: [] }));

    await expect(
      verifyPasswordCredential({ query } as unknown as AuditTransaction, verifier, {
        tenantId: TENANT,
        contactEmail: "absent@example.test",
        password: "not logged",
      }),
    ).resolves.toBeNull();

    expect(verifier.hash).toHaveBeenCalledOnce();
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("INV-AUTH-014: contains no retained-session revocation path", () => {
    const source = readFileSync(
      new URL("../packages/domain/src/session.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("revoked_at");
  });

  it("serializes revoke-all against concurrent issuance through the principal row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: USER, status: "ACTIVE" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      revokeAllSessions({ query } as unknown as AuditTransaction, {
        tenantId: TENANT,
        userId: USER,
        actor: { type: "USER", id: USER },
        occurredAt: INSTANT,
        requestId: "a1000000-0000-0000-0003-000000000001",
        correlationId: "a1000000-0000-0000-0004-000000000001",
        sourceChannel: "API",
        configurationVersionId: "a1000000-0000-0000-0005-000000000001",
      }),
    ).resolves.toEqual({ sessionIds: [], emittedEvents: [] });
    expect(query.mock.calls[0]?.[0]).toContain("from app_user");
    expect(query.mock.calls[0]?.[0]).toContain("for update");
    expect(query.mock.calls[1]?.[0]).toContain("delete from user_session");
  });
});
