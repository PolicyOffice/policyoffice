import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocumentRegisterHandler } from "../../../apps/web/src/document-register.js";
import {
  createPublicationFormHandler,
  createPublishDocumentVersionHandler,
  type PublicationFormPayload,
} from "../../../apps/web/src/publication.js";
import {
  issueSession,
  publishDocumentVersion,
  resolveEffectiveVersion,
  type AuditTransaction,
} from "../../domain/src/index.js";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the publication handler fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const FIXTURE_USER = tenantA.users[0]?.id ?? "";
const DOCUMENT = tenantA.documents[0]?.id ?? "";
const BASELINE_VARIANT = tenantA.documents[0]?.baselineVariantId ?? "";
const DOCUMENT_TYPE = tenantA.documents[0]?.documentTypeId ?? "";
const CLASSIFICATION = tenantA.classifications[0]?.id ?? "";
const CONFIGURATION = tenantA.configuration.id;
const FOREIGN_DOCUMENT = tenantB.documents[0]?.id ?? "";
const FOREIGN_VERSION = tenantB.documents[0]?.draftVersionId ?? "";

const PUBLISHER = "c7000000-0000-0000-0001-000000000001";
const APPROVER = "c7000000-0000-0000-0001-000000000002";
const REQUEST_INSTANT = new Date(new Date(fixture.createdAt).valueOf() + 60 * 60 * 1_000);
const SESSION_INSTANT = new Date(REQUEST_INSTANT.valueOf() - 5 * 60 * 1_000);
const MISSING_DOCUMENT = "c7000000-0000-0000-0098-000000000001";
const MISSING_VERSION = "c7000000-0000-0000-0099-000000000001";

let publisherToken = "";
let approverToken = "";

interface VersionSeed {
  readonly documentId: string;
  readonly variantId: string;
  readonly versionId: string;
  readonly rowVersion: number;
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error(`id factory exhausted after ${index} values`);
    index += 1;
    return value;
  };
}

async function asPrincipal<T>(
  tenantId: string,
  principalId: string,
  fn: (transaction: ApplicationTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction({ tenantId, principal: { type: "USER", id: principalId } }, fn);
}

async function sessionFor(userId: string): Promise<string> {
  const session = await asPrincipal(TENANT_A, userId, (transaction) =>
    issueSession(transaction, {
      tenantId: TENANT_A,
      userId,
      userAgentClass: "POL-046 publication handler test",
      instant: SESSION_INSTANT,
    }),
  );
  return session.token;
}

async function insertVersion(
  transaction: ApplicationTransaction,
  variantId: string,
  versionId: string,
  sequence: number,
  lifecycle: "DRAFT" | "APPROVED",
  title: string,
): Promise<number> {
  await transaction.query(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id,
       materiality, configuration_version_id
     ) values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, 'MATERIAL', $9)`,
    [
      TENANT_A,
      versionId,
      variantId,
      sequence,
      `${sequence}.0`,
      DOCUMENT_TYPE,
      title,
      CLASSIFICATION,
      CONFIGURATION,
    ],
  );
  if (lifecycle === "APPROVED") {
    for (const state of ["IN_REVIEW", "APPROVED"] as const) {
      await transaction.query(
        `update document_version
            set lifecycle_state = $3::version_lifecycle,
                row_version = row_version + 1
          where tenant_id = $1::uuid and id = $2::uuid`,
        [TENANT_A, versionId, state],
      );
    }
    return 3;
  }
  return 1;
}

async function seedVersion(lifecycle: "DRAFT" | "APPROVED" = "APPROVED"): Promise<VersionSeed> {
  const variantId = randomUUID();
  const versionId = randomUUID();
  const rowVersion = await asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    await transaction.query(
      `insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, status
       ) values ($1, $2, $3, 'SUPPLEMENT', $4, 'ACTIVE')`,
      [TENANT_A, variantId, DOCUMENT, BASELINE_VARIANT],
    );
    return insertVersion(
      transaction,
      variantId,
      versionId,
      1,
      lifecycle,
      lifecycle === "APPROVED" ? "Approved publication candidate" : "Draft candidate",
    );
  });
  return { documentId: DOCUMENT, variantId, versionId, rowVersion };
}

async function seedFutureScenario(): Promise<{
  readonly predecessorId: string;
  readonly candidate: VersionSeed;
}> {
  const variantId = randomUUID();
  const predecessorId = randomUUID();
  const candidateId = randomUUID();
  await asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    await transaction.query(
      `insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, status
       ) values ($1, $2, $3, 'SUPPLEMENT', $4, 'ACTIVE')`,
      [TENANT_A, variantId, DOCUMENT, BASELINE_VARIANT],
    );
    await insertVersion(
      transaction,
      variantId,
      predecessorId,
      1,
      "APPROVED",
      "Currently governing publication",
    );
  });
  const predecessorInstant = new Date(REQUEST_INSTANT.valueOf() - 10 * 60 * 1_000);
  await asPrincipal(TENANT_A, PUBLISHER, (transaction) =>
    publishDocumentVersion(transaction as AuditTransaction, {
      tenantId: TENANT_A,
      versionId: predecessorId,
      expectedRowVersion: 3,
      effectiveFrom: predecessorInstant,
      actor: { type: "USER", id: PUBLISHER },
      configurationVersionId: CONFIGURATION,
      occurredAt: predecessorInstant,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      sourceChannel: "WEB",
    }),
  );
  await asPrincipal(TENANT_A, FIXTURE_USER, (transaction) =>
    insertVersion(
      transaction,
      variantId,
      candidateId,
      2,
      "APPROVED",
      "Future publication candidate",
    ),
  );
  return {
    predecessorId,
    candidate: {
      documentId: DOCUMENT,
      variantId,
      versionId: candidateId,
      rowVersion: 3,
    },
  };
}

async function versionState(
  versionId: string,
): Promise<Readonly<{ state: string; rowVersion: number }>> {
  return asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    const { rows } = await transaction.query<
      Record<string, unknown> & { lifecycle_state: string; row_version: number }
    >(
      `select lifecycle_state, row_version
         from document_version
        where tenant_id = $1::uuid and id = $2::uuid`,
      [TENANT_A, versionId],
    );
    const row = rows[0];
    if (!row) throw new Error("publication test version is missing");
    return { state: row.lifecycle_state, rowVersion: row.row_version };
  });
}

async function correlationEvents(correlationId: string): Promise<readonly string[]> {
  return asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    const { rows } = await transaction.query<Record<string, unknown> & { event_type: string }>(
      `select event_type
         from audit_event
        where tenant_id = $1::uuid and correlation_id = $2::uuid
        order by sequence`,
      [TENANT_A, correlationId],
    );
    return rows.map((row) => row.event_type);
  });
}

async function versionEventCount(versionId: string): Promise<number> {
  return asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    const { rows } = await transaction.query<Record<string, unknown> & { count: number }>(
      `select count(*)::int as count
         from audit_event
        where tenant_id = $1::uuid and document_version_id = $2::uuid`,
      [TENANT_A, versionId],
    );
    return rows[0]?.count ?? -1;
  });
}

async function responseShape(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  await asPrincipal(TENANT_A, FIXTURE_USER, async (transaction) => {
    await transaction.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values
         ($1, $2, 'Publication Principal', 'publisher@example.test', 'ACTIVE'),
         ($1, $3, 'Approval Principal', 'approver-only@example.test', 'ACTIVE')`,
      [TENANT_A, PUBLISHER, APPROVER],
    );
    const grants = [
      [randomUUID(), PUBLISHER, "document.read"],
      [randomUUID(), PUBLISHER, "document.publish"],
      [randomUUID(), APPROVER, "document.approve"],
    ] as const;
    for (const [grantId, principalId, capability] of grants) {
      await transaction.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, capability,
           scope_type, scope_id, validity, granted_by, reason
         ) values (
           $1, $2, 'ALLOW', 'USER', $3, $4::capability,
           'TENANT', null, tstzrange($5::timestamptz, null, '[)'), $6,
           'POL-046 publication entry-point fixture'
         )`,
        [TENANT_A, grantId, principalId, capability, fixture.createdAt, FIXTURE_USER],
      );
    }
  });
  publisherToken = await sessionFor(PUBLISHER);
  approverToken = await sessionFor(APPROVER);
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the publication request boundary", () => {
  it("INV-EFF-001 / INV-AUD-001 / INV-AUD-004: preserves future normativity and emits each immediate event exactly once", async () => {
    const { predecessorId, candidate } = await seedFutureScenario();
    const formResponse = await createPublicationFormHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: publisherToken,
      documentId: candidate.documentId,
      versionId: candidate.versionId,
    });
    expect(formResponse.status).toBe(200);
    const form = (await formResponse.json()) as PublicationFormPayload;
    expect(form).toMatchObject({
      versionTitle: "Future publication candidate",
      expectedRowVersion: candidate.rowVersion,
    });

    const registerResponse = await createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: publisherToken });
    const register = (await registerResponse.json()) as {
      publicationCandidates: readonly { versionId: string }[];
    };
    expect(register.publicationCandidates.map((item) => item.versionId)).toContain(
      candidate.versionId,
    );

    const futureCorrelationId = randomUUID();
    const futureResponse = await createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(randomUUID(), futureCorrelationId),
    })({
      sessionToken: publisherToken,
      documentId: candidate.documentId,
      versionId: candidate.versionId,
      expectedRowVersion: form.expectedRowVersion,
      effectiveFrom: new Date(REQUEST_INSTANT.valueOf() + 24 * 60 * 60 * 1_000),
    });
    expect(futureResponse.status).toBe(303);
    expect(await versionState(candidate.versionId)).toMatchObject({ state: "PUBLISHED" });
    expect(
      await asPrincipal(TENANT_A, PUBLISHER, (transaction) =>
        resolveEffectiveVersion(transaction as AuditTransaction, {
          tenantId: TENANT_A,
          documentVariantId: candidate.variantId,
          at: REQUEST_INSTANT,
        }),
      ),
    ).toMatchObject({ id: predecessorId });
    expect(await correlationEvents(futureCorrelationId)).toEqual(["version.published"]);

    const immediate = await seedVersion();
    const immediateCorrelationId = randomUUID();
    const immediateResponse = await createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(randomUUID(), immediateCorrelationId),
    })({
      sessionToken: publisherToken,
      documentId: immediate.documentId,
      versionId: immediate.versionId,
      expectedRowVersion: immediate.rowVersion,
      effectiveFrom: null,
    });
    expect(immediateResponse.status).toBe(303);
    expect(await versionState(immediate.versionId)).toMatchObject({ state: "EFFECTIVE" });
    expect(
      await asPrincipal(TENANT_A, PUBLISHER, (transaction) =>
        resolveEffectiveVersion(transaction as AuditTransaction, {
          tenantId: TENANT_A,
          documentVariantId: immediate.variantId,
          at: REQUEST_INSTANT,
        }),
      ),
    ).toMatchObject({ id: immediate.versionId });
    expect(await correlationEvents(immediateCorrelationId)).toEqual([
      "version.published",
      "version.effective",
    ]);
  });

  it("INV-AUTH-001: refuses an approver who does not hold document.publish", async () => {
    const candidate = await seedVersion();
    const response = await createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: approverToken,
      documentId: candidate.documentId,
      versionId: candidate.versionId,
      expectedRowVersion: candidate.rowVersion,
      effectiveFrom: REQUEST_INSTANT,
    });

    expect(await responseShape(response)).toEqual({
      status: 404,
      contentType: "application/json",
      cacheControl: "no-store",
      body: '{"error":"not_found"}',
    });
    expect(await versionState(candidate.versionId)).toEqual({ state: "APPROVED", rowVersion: 3 });
    expect(await versionEventCount(candidate.versionId)).toBe(0);
  });

  it("INV-TEN-002 / INV-TEN-005: makes foreign and absent version identifiers identical", async () => {
    const handler = createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const [foreign, absent] = await Promise.all([
      handler({
        sessionToken: publisherToken,
        documentId: FOREIGN_DOCUMENT,
        versionId: FOREIGN_VERSION,
        expectedRowVersion: 1,
        effectiveFrom: REQUEST_INSTANT,
      }),
      handler({
        sessionToken: publisherToken,
        documentId: MISSING_DOCUMENT,
        versionId: MISSING_VERSION,
        expectedRowVersion: 1,
        effectiveFrom: REQUEST_INSTANT,
      }),
    ]);

    expect(await responseShape(foreign)).toEqual(await responseShape(absent));
  });

  it("INV-TIME-003: passes the rendered row version through and conflicts on a stale write", async () => {
    const candidate = await seedVersion();
    const response = await createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: publisherToken,
      documentId: candidate.documentId,
      versionId: candidate.versionId,
      expectedRowVersion: candidate.rowVersion - 1,
      effectiveFrom: REQUEST_INSTANT,
    });

    expect(await responseShape(response)).toEqual({
      status: 409,
      contentType: "application/json",
      cacheControl: "no-store",
      body: '{"error":"conflict"}',
    });
    expect(await versionState(candidate.versionId)).toEqual({ state: "APPROVED", rowVersion: 3 });
    expect(await versionEventCount(candidate.versionId)).toBe(0);
  });

  it("refuses non-approved lifecycle and distinguishes retroactive dates from permission denial", async () => {
    const draft = await seedVersion("DRAFT");
    const approved = await seedVersion();
    const handler = createPublishDocumentVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const lifecycle = await handler({
      sessionToken: publisherToken,
      documentId: draft.documentId,
      versionId: draft.versionId,
      expectedRowVersion: draft.rowVersion,
      effectiveFrom: REQUEST_INSTANT,
    });
    const retroactive = await handler({
      sessionToken: publisherToken,
      documentId: approved.documentId,
      versionId: approved.versionId,
      expectedRowVersion: approved.rowVersion,
      effectiveFrom: new Date(REQUEST_INSTANT.valueOf() - 1),
    });

    expect(await responseShape(lifecycle)).toMatchObject({
      status: 409,
      body: '{"error":"invalid_lifecycle"}',
    });
    expect(await responseShape(retroactive)).toMatchObject({
      status: 422,
      body: '{"error":"retroactive_effective_from"}',
    });
    expect(await versionState(draft.versionId)).toEqual({ state: "DRAFT", rowVersion: 1 });
    expect(await versionState(approved.versionId)).toEqual({ state: "APPROVED", rowVersion: 3 });
    expect(await versionEventCount(draft.versionId)).toBe(0);
    expect(await versionEventCount(approved.versionId)).toBe(0);
  });
});
