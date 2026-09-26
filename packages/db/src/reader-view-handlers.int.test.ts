import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createReaderResolutionHandler,
  createReaderVersionHandler,
} from "../../../apps/web/src/reader-view.js";
import { issueSession } from "../../domain/src/index.js";
import { withSuperuser__BYPASSES_RLS } from "@policyoffice/testing";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the reader-view fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const FIXTURE_USER = tenantA.users[0]?.id ?? "";
const DOCUMENT = tenantA.documents[0]?.id ?? "";
const VARIANT = tenantA.documents[0]?.baselineVariantId ?? "";
const FIXTURE_DRAFT_VERSION = tenantA.documents[0]?.draftVersionId ?? "";
const FIXTURE_DRAFT_REVISION = tenantA.documents[0]?.contentRevisionId ?? "";
const FIXTURE_DRAFT_ATTACHMENT = tenantA.documents[0]?.contentAttachmentId ?? "";
const IN_REVIEW_VERSION = tenantA.documents[0]?.approvalVersionId ?? "";
const FOREIGN_DOCUMENT = tenantB.documents[0]?.id ?? "";
const DOCUMENT_TYPE = tenantA.documents[0]?.documentTypeId ?? "";
const CLASSIFICATION = tenantA.classifications[0]?.id ?? "";
const CONFIGURATION = tenantA.configuration.id;

const READ_USER = id(1, 1);
const HISTORY_USER = id(1, 2);
const NO_ACCESS_USER = id(1, 3);
const EXPIRED_USER = id(1, 4);
const SUPERSEDED_VERSION = id(20, 1);
const EFFECTIVE_VERSION = id(20, 2);
const FUTURE_VERSION = id(20, 3);
const CHANGES_VARIANT = id(19, 2);
const CHANGES_VERSION = id(20, 4);
const DRAFT_VARIANT = id(19, 3);
const DRAFT_VERSION = id(20, 5);
const REQUEST_INSTANT = new Date("2026-09-20T09:00:00.000Z");
const SESSION_INSTANT = new Date("2026-09-20T08:55:00.000Z");
const tokens = new Map<string, string>();

function id(namespace: number, ordinal: number): string {
  return `c8000000-0000-0000-${String(namespace).padStart(4, "0")}-${String(ordinal).padStart(12, "0")}`;
}

async function asPrincipal<T>(
  principalId: string,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(
    { tenantId: TENANT_A, principal: { type: "USER", id: principalId } },
    fn,
  );
}

async function sessionFor(userId: string): Promise<string> {
  const session = await asPrincipal(userId, (transaction) =>
    issueSession(transaction, {
      tenantId: TENANT_A,
      userId,
      userAgentClass: "POL-035 reader-view integration test",
      instant: SESSION_INSTANT,
    }),
  );
  return session.token;
}

function token(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`missing token for ${userId}`);
  return value;
}

interface ReleasedVersionInput {
  readonly id: string;
  readonly sequence: number;
  readonly label: string;
  readonly title: string;
  readonly state: "PUBLISHED" | "EFFECTIVE" | "SUPERSEDED";
  readonly publishedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly successorId: string | null;
  readonly digestCharacter: string;
}

async function insertReleasedVersion(
  transaction: ApplicationTransaction,
  input: ReleasedVersionInput,
): Promise<void> {
  const revisionId = id(21, input.sequence);
  const attachmentId = id(22, input.sequence);
  const contentDigest = `sha-256:${input.digestCharacter.repeat(64)}`;
  const attachmentDigest = `sha-256:${input.sequence.toString(16).repeat(64)}`;
  await transaction.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id,
       change_summary, configuration_version_id
     ) values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $9, $10)`,
    [
      TENANT_A,
      input.id,
      VARIANT,
      input.sequence,
      input.label,
      DOCUMENT_TYPE,
      input.title,
      CLASSIFICATION,
      `Change summary for ${input.label}`,
      CONFIGURATION,
    ],
  );
  await transaction.query(
    `insert into content_revision (
       tenant_id, id, document_version_id, revision_sequence, content_ref,
       canonical_manifest, canonicalisation_schema_version, content_digest,
       created_by, submitted_at
     ) values ($1, $2, $3, 1, null, $4::jsonb, 1, $5, $6, null)`,
    [
      TENANT_A,
      revisionId,
      input.id,
      JSON.stringify(`reader-view-${input.label}`),
      contentDigest,
      FIXTURE_USER,
    ],
  );
  await transaction.query(
    `insert into content_attachment (
       tenant_id, id, content_revision_id, filename, media_type,
       byte_size, storage_ref, digest
     ) values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7)`,
    [
      TENANT_A,
      attachmentId,
      revisionId,
      `reader-policy-${input.label}.pdf`,
      1_000 + input.sequence,
      `t/${TENANT_A}/blob/${attachmentDigest.slice("sha-256:".length)}`,
      attachmentDigest,
    ],
  );
  await transaction.query(
    `update content_revision
        set submitted_at = $1::timestamptz, row_version = row_version + 1
      where tenant_id = $2 and id = $3`,
    [input.publishedAt, TENANT_A, revisionId],
  );
  await transaction.query(
    `update document_version
        set lifecycle_state = 'IN_REVIEW',
            approved_revision_id = $1,
            content_digest = $2,
            materiality = 'MATERIAL',
            approved_at = $3::timestamptz,
            published_at = $3::timestamptz,
            effective_from = $4::timestamptz,
            effective_until = $5::timestamptz,
            superseded_by_version_id = $6,
            row_version = row_version + 1
      where tenant_id = $7 and id = $8`,
    [
      revisionId,
      contentDigest,
      input.publishedAt,
      input.effectiveFrom,
      input.effectiveUntil,
      input.successorId,
      TENANT_A,
      input.id,
    ],
  );
  const lifecyclePath = ["APPROVED", "PUBLISHED"] as const;
  const releasedPath =
    input.state === "PUBLISHED"
      ? lifecyclePath
      : input.state === "EFFECTIVE"
        ? [...lifecyclePath, "EFFECTIVE"]
        : [...lifecyclePath, "EFFECTIVE", "SUPERSEDED"];
  for (const lifecycle of releasedPath) {
    await transaction.query(
      `update document_version
          set lifecycle_state = $1::version_lifecycle,
              row_version = row_version + 1
        where tenant_id = $2 and id = $3`,
      [lifecycle, TENANT_A, input.id],
    );
  }
}

async function removeReaderReleasedFixtures(): Promise<void> {
  await withSuperuser__BYPASSES_RLS(async (sql) => {
    await sql.query("begin");
    try {
      // Released content is correctly undeletable through governed paths. Replica mode is
      // confined to deterministic test teardown, outside every behavioral assertion.
      await sql.query("set local session_replication_role = replica");
      await sql.query("delete from content_attachment where tenant_id = $1 and id = any($2)", [
        TENANT_A,
        [FIXTURE_DRAFT_ATTACHMENT, id(22, 2), id(22, 3), id(22, 4)],
      ]);
      await sql.query("delete from content_revision where tenant_id = $1 and id = any($2)", [
        TENANT_A,
        [FIXTURE_DRAFT_REVISION, id(21, 2), id(21, 3), id(21, 4)],
      ]);
      await sql.query("delete from document_version where tenant_id = $1 and id = any($2)", [
        TENANT_A,
        [FIXTURE_DRAFT_VERSION, SUPERSEDED_VERSION, EFFECTIVE_VERSION, FUTURE_VERSION],
      ]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

beforeAll(async () => {
  await removeReaderReleasedFixtures();
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  await asPrincipal(FIXTURE_USER, async (transaction) => {
    await transaction.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values
         ($1, $2, 'Reader View Reader', 'reader-view-reader@example.test', 'ACTIVE'),
         ($1, $3, 'Reader View Historian', 'reader-view-history@example.test', 'ACTIVE'),
         ($1, $4, 'Reader View No Access', 'reader-view-none@example.test', 'ACTIVE'),
         ($1, $5, 'Reader View Expired', 'reader-view-expired@example.test', 'ACTIVE')`,
      [TENANT_A, READ_USER, HISTORY_USER, NO_ACCESS_USER, EXPIRED_USER],
    );
    await transaction.query(
      `update document
          set owner_user_id = $1, row_version = row_version + 1
        where tenant_id = $2 and id = $3`,
      [FIXTURE_USER, TENANT_A, DOCUMENT],
    );
    await transaction.query(
      `update document_version
          set lifecycle_state = 'CANCELLED',
              cancelled_at = $1::timestamptz,
              cancellation_reason = 'Reader-view fixture releases the baseline',
              row_version = row_version + 1
        where tenant_id = $2 and id = $3`,
      [REQUEST_INSTANT.toISOString(), TENANT_A, FIXTURE_DRAFT_VERSION],
    );

    await insertReleasedVersion(transaction, {
      id: EFFECTIVE_VERSION,
      sequence: 3,
      label: "2.0",
      title: "Reader policy governing version",
      state: "EFFECTIVE",
      publishedAt: "2025-12-01T00:00:00.000Z",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      successorId: null,
      digestCharacter: "b",
    });
    await insertReleasedVersion(transaction, {
      id: SUPERSEDED_VERSION,
      sequence: 2,
      label: "1.0",
      title: "Reader policy historical version",
      state: "SUPERSEDED",
      publishedAt: "2024-12-01T00:00:00.000Z",
      effectiveFrom: "2025-01-01T00:00:00.000Z",
      effectiveUntil: "2026-01-01T00:00:00.000Z",
      successorId: EFFECTIVE_VERSION,
      digestCharacter: "a",
    });
    await insertReleasedVersion(transaction, {
      id: FUTURE_VERSION,
      sequence: 4,
      label: "3.0",
      title: "Reader policy scheduled version",
      state: "PUBLISHED",
      publishedAt: "2026-09-01T00:00:00.000Z",
      effectiveFrom: "2027-01-01T00:00:00.000Z",
      effectiveUntil: null,
      successorId: null,
      digestCharacter: "c",
    });

    await transaction.query(
      `insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, locale, status
       ) values ($1, $2, $3, 'SUPPLEMENT', $4, null, 'ACTIVE')`,
      [TENANT_A, CHANGES_VARIANT, DOCUMENT, VARIANT],
    );
    await transaction.query(
      `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id,
       configuration_version_id
       ) values ($1, $2, $3, 1, 'changes', 'DRAFT', $4,
                 'Hidden changes requested version', $5, $6)`,
      [TENANT_A, CHANGES_VERSION, CHANGES_VARIANT, DOCUMENT_TYPE, CLASSIFICATION, CONFIGURATION],
    );
    for (const lifecycle of ["IN_REVIEW", "CHANGES_REQUESTED"] as const) {
      await transaction.query(
        `update document_version
            set lifecycle_state = $1::version_lifecycle,
                row_version = row_version + 1
          where tenant_id = $2 and id = $3`,
        [lifecycle, TENANT_A, CHANGES_VERSION],
      );
    }
    await transaction.query(
      `insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, locale, status
       ) values ($1, $2, $3, 'SUPPLEMENT', $4, null, 'ACTIVE')`,
      [TENANT_A, DRAFT_VARIANT, DOCUMENT, VARIANT],
    );
    await transaction.query(
      `insert into document_version (
         tenant_id, id, document_variant_id, version_sequence, display_label,
         lifecycle_state, document_type_id, title, classification_id,
         configuration_version_id
       ) values ($1, $2, $3, 1, 'draft', 'DRAFT', $4,
                 'Hidden draft version', $5, $6)`,
      [TENANT_A, DRAFT_VERSION, DRAFT_VARIANT, DOCUMENT_TYPE, CLASSIFICATION, CONFIGURATION],
    );

    await transaction.query(
      `insert into access_grant (
         tenant_id, id, effect, principal_type, principal_id, capability,
         scope_type, scope_id, validity, granted_by, reason
       ) values
         ($1, $2, 'ALLOW', 'USER', $3, 'document.read', 'DOCUMENT', $4,
          tstzrange($5::timestamptz, null, '[)'), $6, 'POL-035 reader'),
         ($1, $7, 'ALLOW', 'USER', $8, 'document.read_history', 'DOCUMENT', $4,
          tstzrange($5::timestamptz, null, '[)'), $6, 'POL-035 historian'),
         ($1, $9, 'ALLOW', 'USER', $10, 'document.read', 'DOCUMENT', $4,
          tstzrange($5::timestamptz, $11::timestamptz, '[)'), $6, 'POL-035 expired reader')`,
      [
        TENANT_A,
        id(25, 1),
        READ_USER,
        DOCUMENT,
        fixture.createdAt,
        FIXTURE_USER,
        id(25, 2),
        HISTORY_USER,
        id(25, 3),
        EXPIRED_USER,
        "2026-01-01T00:00:00.000Z",
      ],
    );
  });

  for (const userId of [READ_USER, HISTORY_USER, NO_ACCESS_USER, EXPIRED_USER]) {
    tokens.set(userId, await sessionFor(userId));
  }
});

afterAll(async () => {
  await removeReaderReleasedFixtures();
  await removeFixtureSetForTests("test");
});

describe("reader view request boundaries", () => {
  it("INV-EFF-001 / INV-TIME-001: resolves the governing version and labels the later scheduled version separately", async () => {
    const handle = createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const record = await handle({ sessionToken: token(READ_USER), documentId: DOCUMENT });
    const effective = await handle({ sessionToken: token(READ_USER), documentId: DOCUMENT });
    const payload = (await record.json()) as {
      view: {
        document: { owner: { name: string }; owningScope: { name: string } };
        version: {
          id: string;
          effectiveFrom: string;
          classification: { name: string; handlingInstructions: string };
          attachments: readonly { filename: string; mediaType: string; byteSize: string }[];
        };
        laterPublishedVersion: { id: string; bindsFrom: string };
      };
      answeredAt: string;
    };

    expect(record.status).toBe(200);
    expect(effective.status).toBe(200);
    expect(payload).toMatchObject({
      view: {
        document: {
          owner: { name: tenantA.users[0]?.displayName },
          owningScope: { name: tenantA.orgUnit.name },
        },
        version: {
          id: EFFECTIVE_VERSION,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          classification: {
            name: tenantA.classifications[0]?.name,
            handlingInstructions: tenantA.classifications[0]?.handlingInstructions,
          },
          attachments: [
            {
              filename: "reader-policy-2.0.pdf",
              mediaType: "application/pdf",
              byteSize: "1003",
            },
          ],
        },
        laterPublishedVersion: {
          id: FUTURE_VERSION,
          bindsFrom: "2027-01-01T00:00:00.000Z",
        },
      },
      answeredAt: REQUEST_INSTANT.toISOString(),
    });
  });

  it("INV-AUTH-001: document.read does not reveal a superseded version", async () => {
    const response = await createReaderVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: token(READ_USER),
      documentId: DOCUMENT,
      versionId: SUPERSEDED_VERSION,
    });
    expect(response.status).toBe(404);
  });

  it("INV-AUTH-001: document.read_history reveals the superseded version and successor", async () => {
    const response = await createReaderVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: token(HISTORY_USER),
      documentId: DOCUMENT,
      versionId: SUPERSEDED_VERSION,
    });
    const payload = (await response.json()) as {
      view: {
        version: { id: string; governsAtRequestInstant: boolean; supersededBy: { id: string } };
      };
    };
    expect(response.status).toBe(200);
    expect(payload.view.version).toMatchObject({
      id: SUPERSEDED_VERSION,
      governsAtRequestInstant: false,
      supersededBy: { id: EFFECTIVE_VERSION },
    });
  });

  it("INV-EFF-006: resolves a historical instant and states when nothing governed", async () => {
    const handle = createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const historical = await handle({
      sessionToken: token(HISTORY_USER),
      documentId: DOCUMENT,
      at: "2025-06-01T12:00:00.000Z",
    });
    const beforeFirst = await handle({
      sessionToken: token(HISTORY_USER),
      documentId: DOCUMENT,
      at: "2024-06-01T12:00:00.000Z",
    });
    expect(historical.status).toBe(200);
    expect(await historical.json()).toMatchObject({
      view: { version: { id: SUPERSEDED_VERSION } },
      answeredAt: "2025-06-01T12:00:00.000Z",
    });
    expect(beforeFirst.status).toBe(200);
    expect(await beforeFirst.json()).toMatchObject({
      view: { version: null },
      answeredAt: "2024-06-01T12:00:00.000Z",
    });
  });

  it("INV-AUTH-001: document.read cannot use an as-of address to reach history", async () => {
    const handle = createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const response = await handle({
      sessionToken: token(READ_USER),
      documentId: DOCUMENT,
      at: "2025-06-01T12:00:00.000Z",
    });
    const beforeFirst = await handle({
      sessionToken: token(READ_USER),
      documentId: DOCUMENT,
      at: "2024-06-01T12:00:00.000Z",
    });
    expect(response.status).toBe(404);
    expect(beforeFirst.status).toBe(404);
  });

  it("INV-EFF-001: a scheduled exact version is never marked as governing now", async () => {
    const response = await createReaderVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: token(HISTORY_USER),
      documentId: DOCUMENT,
      versionId: FUTURE_VERSION,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      view: {
        version: {
          id: FUTURE_VERSION,
          effectiveFrom: "2027-01-01T00:00:00.000Z",
          governsAtRequestInstant: false,
        },
      },
    });
  });

  it.each([DRAFT_VERSION, IN_REVIEW_VERSION, CHANGES_VERSION])(
    "INV-VER-003 / INV-VER-010: pre-release version %s is not found",
    async (versionId) => {
      const response = await createReaderVersionHandler({
        tenantId: TENANT_A,
        clock: () => REQUEST_INSTANT,
      })({ sessionToken: token(HISTORY_USER), documentId: DOCUMENT, versionId });
      expect(response.status).toBe(404);
    },
  );

  it("INV-AUTH-001 / INV-AUTH-003: missing and expired grants fail closed", async () => {
    const handle = createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const missing = await handle({ sessionToken: token(NO_ACCESS_USER), documentId: DOCUMENT });
    const expired = await handle({ sessionToken: token(EXPIRED_USER), documentId: DOCUMENT });
    expect(missing.status).toBe(404);
    expect(expired.status).toBe(404);
  });

  it("INV-TEN-002 / INV-TEN-005: absent and cross-tenant documents are identical", async () => {
    const handle = createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const absent = await handle({ sessionToken: token(READ_USER), documentId: id(99, 1) });
    const crossTenant = await handle({
      sessionToken: token(READ_USER),
      documentId: FOREIGN_DOCUMENT,
    });
    expect(absent.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(await absent.text()).toBe('{"error":"not_found"}');
    expect(await crossTenant.text()).toBe('{"error":"not_found"}');
  });

  it("refuses an as-of address without an explicit timezone", async () => {
    const response = await createReaderResolutionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: token(READ_USER),
      documentId: DOCUMENT,
      at: "2025-06-01T12:00:00",
    });
    expect(response.status).toBe(404);
  });
});
