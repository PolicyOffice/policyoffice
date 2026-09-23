import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ContentStorageHandlerOptions,
  type ContentUploadSlotPayload,
  createContentUploadSlotHandler,
  createContentRevisionHandler,
  createDraftWorkspaceHandler,
  createDocumentHandler,
  createSubmitContentRevisionHandler,
  createVersionFormHandler,
  createVersionHandler,
} from "../../../apps/web/src/authoring.js";
import {
  createDocumentFormHandler,
  createDocumentRegisterHandler,
} from "../../../apps/web/src/document-register.js";
import {
  inspectContentBytes,
  issueSession,
  sha256Digest,
  type Capability,
} from "../../domain/src/index.js";
import {
  createControlledFileStorage,
  prepareLocalStorageBucket,
  storageConfiguration,
} from "../../storage/src/index.js";
import { withTenantTransaction, type ApplicationTransaction } from "./application-transaction.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the author-path fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const TENANT_B = tenantB.tenant.id;
const FIXTURE_USER_A = tenantA.users[0]?.id ?? "";
const FIXTURE_USER_B = tenantB.users[0]?.id ?? "";
const FIXTURE_DOCUMENT_A = tenantA.documents[0]?.id ?? "";
const FIXTURE_VERSION_A = tenantA.documents[0]?.draftVersionId ?? "";
const FIXTURE_REVISION_A = tenantA.documents[0]?.contentRevisionId ?? "";
const FIXTURE_DOCUMENT_B = tenantB.documents[0]?.id ?? "";
const FIXTURE_VERSION_B = tenantB.documents[0]?.draftVersionId ?? "";
const FIXTURE_REVISION_B = tenantB.documents[0]?.contentRevisionId ?? "";

const FULL_AUTHOR = "c3000000-0000-0000-0001-000000000001";
const NO_CREATE_AUTHOR = "c3000000-0000-0000-0001-000000000002";
const NO_START_AUTHOR = "c3000000-0000-0000-0001-000000000003";
const NO_SAVE_AUTHOR = "c3000000-0000-0000-0001-000000000004";
const NO_SUBMIT_AUTHOR = "c3000000-0000-0000-0001-000000000005";

const CREATED_DOCUMENT = "c3000000-0000-0000-0018-000000000001";
const CREATED_VARIANT = "c3000000-0000-0000-0019-000000000001";
const CREATED_VERSION = "c3000000-0000-0000-0020-000000000001";
const FIRST_REVISION = "c3000000-0000-0000-0021-000000000001";
const SECOND_REVISION = "c3000000-0000-0000-0021-000000000002";
const FIRST_SLOT = "c3000000-0000-0000-0022-000000000001";
const SECOND_SLOT = "c3000000-0000-0000-0022-000000000002";
const MISSING_DOCUMENT = "c3000000-0000-0000-0099-000000000001";
const REQUEST_INSTANT = new Date("2026-09-13T12:00:00.000Z");
const SESSION_INSTANT = new Date("2026-09-13T11:55:00.000Z");
const AUTHOR_CAPABILITIES = Object.freeze([
  "document.read",
  "document.create",
  "document.edit_draft",
  "document.submit",
] as const satisfies readonly Capability[]);
const NOT_FOUND_SHAPE = Object.freeze({
  status: 404,
  contentType: "application/json",
  cacheControl: "no-store",
  body: '{"error":"not_found"}',
});

const storageConfig = storageConfiguration({
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "minioadmin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "minioadmin",
  S3_BUCKET: "policyoffice-pol044-handler-test",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
});
const realStorage = createControlledFileStorage(storageConfig);
const requestStorage: ContentStorageHandlerOptions["storage"] = {
  createUploadSlot(input) {
    return realStorage.createUploadSlot({ ...input, issuedAt: new Date() });
  },
  verifyAndStoreUpload(claims, now) {
    return realStorage.verifyAndStoreUpload(claims, now);
  },
  consumeUpload(claims) {
    return realStorage.consumeUpload(claims);
  },
};

const tokens = new Map<string, string>();

function ids(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error(`id factory exhausted after ${index} values`);
    index += 1;
    return value;
  };
}

function generatedIds(namespace: number, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `c3000000-0000-0000-${String(namespace).padStart(4, "0")}-${String(index + 1).padStart(12, "0")}`,
  );
}

function storageFor(
  bytes: Uint8Array,
  options: Readonly<{ failConsumption?: boolean }> = {},
): ContentStorageHandlerOptions["storage"] {
  const copied = new Uint8Array(bytes);
  return {
    async createUploadSlot() {
      throw new Error("this test finalizes a previously issued slot");
    },
    async verifyAndStoreUpload(claims) {
      const inspected = inspectContentBytes(claims.tenantId, copied);
      return {
        ...inspected,
        contentBytes: new Uint8Array(copied),
        quarantineKey: `quarantine/${claims.slotId}`,
      };
    },
    async consumeUpload() {
      if (options.failConsumption) throw new Error("simulated quarantine cleanup failure");
    },
  };
}

function finalizationRequest(bytes: Uint8Array, revisionId: string, slotId: string) {
  return {
    revisionId,
    slotId,
    claimedDigest: sha256Digest(bytes),
    claimedByteSize: bytes.byteLength,
    expiresAt: new Date(REQUEST_INSTANT.valueOf() + 60_000).toISOString(),
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
  const issued = await asPrincipal(TENANT_A, userId, (transaction) =>
    issueSession(transaction, {
      tenantId: TENANT_A,
      userId,
      userAgentClass: "POL-033 direct handler test",
      instant: SESSION_INSTANT,
    }),
  );
  return issued.token;
}

async function responseShape(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return Object.freeze({
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  });
}

function token(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`missing test session for ${userId}`);
  return value;
}

async function directUpload(
  bytes: Uint8Array,
  claimedDigest: string,
  documentId: string = FIXTURE_DOCUMENT_A,
  versionId: string = FIXTURE_VERSION_A,
): Promise<{ slot: ContentUploadSlotPayload; finalized: Response }> {
  const slotResponse = await createContentUploadSlotHandler({
    tenantId: TENANT_A,
    clock: () => REQUEST_INSTANT,
    storage: requestStorage,
  })({
    sessionToken: token(FULL_AUTHOR),
    documentId,
    versionId,
    claimedDigest,
    claimedByteSize: bytes.byteLength,
  });
  expect(slotResponse.status).toBe(201);
  const slot = (await slotResponse.json()) as ContentUploadSlotPayload;
  const uploadResponse = await fetch(slot.uploadUrl, {
    method: "PUT",
    headers: slot.requiredHeaders,
    body: bytes,
  });
  expect(uploadResponse.status).toBe(200);
  const finalized = await createContentRevisionHandler({
    tenantId: TENANT_A,
    clock: () => REQUEST_INSTANT,
    storage: requestStorage,
  })({
    sessionToken: token(FULL_AUTHOR),
    documentId,
    versionId,
    revisionId: slot.revisionId,
    slotId: slot.slotId,
    claimedDigest: slot.claimedDigest,
    claimedByteSize: slot.claimedByteSize,
    expiresAt: slot.expiresAt,
  });
  return { slot, finalized };
}

async function insertAuthorFixtures(): Promise<void> {
  const users = [FULL_AUTHOR, NO_CREATE_AUTHOR, NO_START_AUTHOR, NO_SAVE_AUTHOR, NO_SUBMIT_AUTHOR];
  const omittedCapability = new Map<string, Capability | null>([
    [FULL_AUTHOR, null],
    [NO_CREATE_AUTHOR, "document.create"],
    [NO_START_AUTHOR, "document.edit_draft"],
    [NO_SAVE_AUTHOR, "document.edit_draft"],
    [NO_SUBMIT_AUTHOR, "document.submit"],
  ]);

  await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
    for (const [index, userId] of users.entries()) {
      await transaction.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, $3, $4, 'ACTIVE')`,
        [TENANT_A, userId, `Author ${index + 1}`, `author-${index + 1}@example.test`],
      );
      for (const [capabilityIndex, capability] of AUTHOR_CAPABILITIES.entries()) {
        if (capability === omittedCapability.get(userId)) continue;
        const grantId = `c3000000-0000-0000-0002-${String(index * 10 + capabilityIndex + 1).padStart(12, "0")}`;
        await transaction.query(
          `insert into access_grant (
             tenant_id, id, effect, principal_type, principal_id, capability,
             scope_type, scope_id, validity, granted_by, reason
           ) values (
             $1, $2, 'ALLOW', 'USER', $3, $4::capability, 'TENANT', null,
             tstzrange($5::timestamptz, null, '[)'), $6, 'POL-033 author-path fixture'
           )`,
          [TENANT_A, grantId, userId, capability, fixture.createdAt, FIXTURE_USER_A],
        );
      }
    }
  });

  for (const userId of users) tokens.set(userId, await sessionFor(userId));
}

beforeAll(async () => {
  await prepareLocalStorageBucket(storageConfig);
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  await insertAuthorFixtures();
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the author path request boundaries", () => {
  it("INV-DOC-007 / INV-VER-001 / INV-VER-002: creates one planned document, saves two revisions, and submits the selected revision", async () => {
    const createDocumentBoundary = createDocumentHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(CREATED_DOCUMENT, CREATED_VARIANT, ...generatedIds(30, 2)),
    });
    const createResponse = await createDocumentBoundary({
      sessionToken: token(FULL_AUTHOR),
      documentCode: "POL-033",
      canonicalTitle: "Author Path Policy",
      documentTypeCode: "POLICY",
      owningOrgUnitCode: "HEAD_OFFICE",
      spaceCode: "POLICIES",
    });
    expect(createResponse.status).toBe(303);
    expect(createResponse.headers.get("location")).toBe(`/author/documents/${CREATED_DOCUMENT}`);

    const versionFormResponse = await createVersionFormHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(FULL_AUTHOR), documentId: CREATED_DOCUMENT });
    expect(versionFormResponse.status).toBe(200);
    expect(await versionFormResponse.json()).toEqual({
      documentCode: "POL-033",
      canonicalTitle: "Author Path Policy",
      lifecycleStatus: "PLANNED",
    });

    const createVersionBoundary = createVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(CREATED_VERSION, ...generatedIds(31, 2)),
    });
    const versionResponse = await createVersionBoundary({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      displayLabel: "1.0",
      classificationCode: "INTERNAL",
      materiality: "MATERIAL",
      changeSummary: "Initial governed draft",
    });
    expect(versionResponse.status).toBe(303);
    expect(versionResponse.headers.get("location")).toBe(
      `/author/documents/${CREATED_DOCUMENT}/versions/${CREATED_VERSION}`,
    );

    const draftWorkspace = createDraftWorkspaceHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const draftWorkspaceResponse = await draftWorkspace({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
    });
    expect(draftWorkspaceResponse.status).toBe(200);
    expect(await draftWorkspaceResponse.json()).toEqual({
      lifecycleState: "DRAFT",
      canSubmit: true,
    });

    const firstBytes = new TextEncoder().encode("First author draft.");
    const secondBytes = new TextEncoder().encode("Second author draft.");
    const firstSave = createContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(...generatedIds(32, 2)),
      storage: storageFor(firstBytes, { failConsumption: true }),
    });
    const secondSave = createContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(...generatedIds(33, 2)),
      storage: storageFor(secondBytes),
    });
    const firstResponse = await firstSave({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
      ...finalizationRequest(firstBytes, FIRST_REVISION, FIRST_SLOT),
    });
    const secondResponse = await secondSave({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
      ...finalizationRequest(secondBytes, SECOND_REVISION, SECOND_SLOT),
    });
    const firstSavedLocation = new URL(firstResponse.headers.get("location") ?? "", "http://local");
    const secondSavedLocation = new URL(
      secondResponse.headers.get("location") ?? "",
      "http://local",
    );
    expect(firstResponse.status).toBe(303);
    expect(secondResponse.status).toBe(303);
    expect(firstSavedLocation.searchParams.get("revisionId")).toBe(FIRST_REVISION);
    expect(secondSavedLocation.searchParams.get("revisionId")).toBe(SECOND_REVISION);
    expect([...firstSavedLocation.searchParams.keys()].sort()).toEqual([
      "revisionId",
      "revisionRowVersion",
      "versionRowVersion",
    ]);

    const selectedDigest = await asPrincipal(TENANT_A, FULL_AUTHOR, async (transaction) => {
      const { rows } = await transaction.query<
        Record<string, unknown> & { content_digest: string }
      >(`select content_digest from content_revision where id = $1`, [FIRST_REVISION]);
      const row = rows[0];
      if (!row) throw new Error("the selected revision was not persisted");
      return row.content_digest;
    });

    const submitBoundary = createSubmitContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      idFactory: ids(...generatedIds(34, 2)),
    });
    const submitResponse = await submitBoundary({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
      revisionId: firstSavedLocation.searchParams.get("revisionId") ?? "",
      expectedVersionRowVersion: Number(firstSavedLocation.searchParams.get("versionRowVersion")),
      expectedRevisionRowVersion: Number(firstSavedLocation.searchParams.get("revisionRowVersion")),
    });
    expect(submitResponse.status).toBe(303);

    const submittedWorkspaceResponse = await draftWorkspace({
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
    });
    expect(submittedWorkspaceResponse.status).toBe(200);
    expect(await submittedWorkspaceResponse.json()).toEqual({
      lifecycleState: "IN_REVIEW",
      canSubmit: true,
    });

    await asPrincipal(TENANT_A, FULL_AUTHOR, async (transaction) => {
      const document = await transaction.query<
        Record<string, unknown> & { lifecycle_status: string }
      >(
        `select lifecycle_status from document
          where tenant_id = $1 and id = $2`,
        [TENANT_A, CREATED_DOCUMENT],
      );
      const versions = await transaction.query<
        Record<string, unknown> & { id: string; lifecycle_state: string }
      >(
        `select version.id, version.lifecycle_state
           from document_version version
           join document_variant variant
             on variant.tenant_id = version.tenant_id
            and variant.id = version.document_variant_id
          where version.tenant_id = $1 and variant.document_id = $2`,
        [TENANT_A, CREATED_DOCUMENT],
      );
      const revisions = await transaction.query<
        Record<string, unknown> & {
          id: string;
          revision_sequence: number;
          content_digest: string;
          submitted_at: Date | null;
        }
      >(
        `select id, revision_sequence, content_digest, submitted_at from content_revision
          where tenant_id = $1 and document_version_id = $2
          order by revision_sequence`,
        [TENANT_A, CREATED_VERSION],
      );
      const events = await transaction.query<
        Record<string, unknown> & { event_type: string; safe_after: Record<string, unknown> }
      >(
        `select event_type, safe_after from audit_event
          where tenant_id = $1 and document_id = $2`,
        [TENANT_A, CREATED_DOCUMENT],
      );

      expect(document.rows).toEqual([{ lifecycle_status: "PLANNED" }]);
      expect(versions.rows).toEqual([{ id: CREATED_VERSION, lifecycle_state: "IN_REVIEW" }]);
      expect(revisions.rows).toHaveLength(2);
      expect(
        revisions.rows.map(({ id, revision_sequence }) => ({ id, revision_sequence })),
      ).toEqual([
        { id: FIRST_REVISION, revision_sequence: 1 },
        { id: SECOND_REVISION, revision_sequence: 2 },
      ]);
      expect(
        revisions.rows.filter((revision) => revision.submitted_at !== null).map(({ id }) => id),
      ).toEqual([FIRST_REVISION]);
      expect(revisions.rows.find(({ id }) => id === FIRST_REVISION)?.content_digest).toBe(
        selectedDigest,
      );
      expect(revisions.rows.find(({ id }) => id === SECOND_REVISION)?.submitted_at).toBeNull();
      expect(events.rows.map(({ event_type }) => event_type).sort()).toEqual([
        "approval_run.started",
        "approval_stage.started",
        "approval_task.assigned",
        "content_revision.created",
        "content_revision.created",
        "document.created",
        "version.created",
        "version.submitted",
      ]);
      expect(
        events.rows.find(({ event_type }) => event_type === "version.submitted")?.safe_after,
      ).toMatchObject({ contentRevisionId: FIRST_REVISION, contentDigest: selectedDigest });
    });
  });

  it("INV-AUTH-001 / INV-TEN-001 / INV-VER-009 / INV-VER-010: authorizes a single-use slot and records only server-verified MinIO bytes", async () => {
    const deniedHandler = createContentUploadSlotHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      storage: requestStorage,
    });
    const deniedRequest = {
      sessionToken: token(NO_SAVE_AUTHOR),
      documentId: FIXTURE_DOCUMENT_A,
      versionId: FIXTURE_VERSION_A,
      claimedDigest: sha256Digest(new TextEncoder().encode("denied")),
      claimedByteSize: 6,
    };
    const denied = await responseShape(await deniedHandler(deniedRequest));
    const absent = await responseShape(
      await deniedHandler({ ...deniedRequest, versionId: MISSING_DOCUMENT }),
    );
    expect(denied).toEqual(absent);

    const submitted = await deniedHandler({
      ...deniedRequest,
      sessionToken: token(FULL_AUTHOR),
      documentId: CREATED_DOCUMENT,
      versionId: CREATED_VERSION,
    });
    expect(await responseShape(submitted)).toEqual(absent);

    const mismatchedBytes = new TextEncoder().encode("the server measures this content");
    const mismatched = await directUpload(mismatchedBytes, `sha-256:${"0".repeat(64)}`);
    expect(mismatched.finalized.status).toBe(303);
    expect(mismatched.finalized.headers.get("location")).toBe(
      `/author/documents/${FIXTURE_DOCUMENT_A}/versions/${FIXTURE_VERSION_A}?error=upload`,
    );
    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query(
        "select id from content_revision where tenant_id = $1 and id = $2",
        [TENANT_A, mismatched.slot.revisionId],
      );
      expect(rows).toEqual([]);
    });

    const verifiedBytes = new TextEncoder().encode("the same server-verified governed bytes");
    const first = await directUpload(verifiedBytes, sha256Digest(verifiedBytes));
    const second = await directUpload(verifiedBytes, sha256Digest(verifiedBytes));
    expect(first.finalized.status).toBe(303);
    expect(second.finalized.status).toBe(303);

    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query<
        Record<string, unknown> & { id: string; content_ref: string }
      >(
        `select id, content_ref from content_revision
          where tenant_id = $1 and id = any($2::uuid[])
          order by id`,
        [TENANT_A, [first.slot.revisionId, second.slot.revisionId]],
      );
      expect(rows).toHaveLength(2);
      const expectedReference = `t/${TENANT_A}/blob/${sha256Digest(verifiedBytes).slice("sha-256:".length)}`;
      expect(rows.map(({ content_ref }) => content_ref)).toEqual([
        expectedReference,
        expectedReference,
      ]);
    });
  });

  it("INV-AUTH-001: denies document creation while the same user holds every other author capability", async () => {
    const handle = createDocumentHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const request = {
      sessionToken: token(NO_CREATE_AUTHOR),
      documentCode: "DENIED-CREATE",
      canonicalTitle: "Must not exist",
      documentTypeCode: "POLICY",
      owningOrgUnitCode: "HEAD_OFFICE",
      spaceCode: "POLICIES",
    };
    const response = await handle(request);
    const invalidResponse = await handle({ ...request, documentCode: "" });

    expect(await responseShape(response)).toEqual(NOT_FOUND_SHAPE);
    expect(await responseShape(invalidResponse)).toEqual(NOT_FOUND_SHAPE);
    const registerResponse = await createDocumentRegisterHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({ sessionToken: token(NO_CREATE_AUTHOR) });
    const register = (await registerResponse.json()) as { readonly canCreate: boolean };
    expect(registerResponse.status).toBe(200);
    expect(register.canCreate).toBe(false);
    expect(
      await responseShape(
        await createDocumentFormHandler({
          tenantId: TENANT_A,
          clock: () => REQUEST_INSTANT,
        })({ sessionToken: token(NO_CREATE_AUTHOR) }),
      ),
    ).toEqual(NOT_FOUND_SHAPE);
    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query(`select id from document where document_code = $1`, [
        "DENIED-CREATE",
      ]);
      expect(rows).toEqual([]);
    });
  });

  it("INV-AUTH-001: denies starting a version identically to a missing document", async () => {
    const handle = createVersionHandler({ tenantId: TENANT_A, clock: () => REQUEST_INSTANT });
    const request = {
      sessionToken: token(NO_START_AUTHOR),
      displayLabel: null,
      classificationCode: "INTERNAL",
      materiality: "MATERIAL" as const,
      changeSummary: null,
    };
    const denied = await responseShape(
      await handle({ ...request, documentId: FIXTURE_DOCUMENT_A }),
    );
    const absent = await responseShape(await handle({ ...request, documentId: MISSING_DOCUMENT }));
    const invalid = await responseShape(
      await handle({ ...request, documentId: FIXTURE_DOCUMENT_A, classificationCode: "" }),
    );

    expect(denied).toEqual(absent);
    expect(invalid).toEqual(absent);
    expect(
      await responseShape(
        await createVersionFormHandler({
          tenantId: TENANT_A,
          clock: () => REQUEST_INSTANT,
        })({ sessionToken: token(NO_START_AUTHOR), documentId: FIXTURE_DOCUMENT_A }),
      ),
    ).toEqual(absent);
    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query(
        `select id from document_version where tenant_id = $1 and document_variant_id = $2`,
        [TENANT_A, tenantA.documents[0]?.baselineVariantId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("INV-AUTH-001: denies saving a revision identically to a missing version", async () => {
    const bytes = new TextEncoder().encode("Denied author save.");
    const countBefore = await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query<Record<string, unknown> & { count: number }>(
        `select count(*)::int as count from content_revision
          where tenant_id = $1 and document_version_id = $2`,
        [TENANT_A, FIXTURE_VERSION_A],
      );
      return rows[0]?.count ?? -1;
    });
    const handle = createContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      storage: storageFor(bytes),
    });
    const request = {
      sessionToken: token(NO_SAVE_AUTHOR),
      documentId: FIXTURE_DOCUMENT_A,
      ...finalizationRequest(bytes, FIRST_REVISION, FIRST_SLOT),
    };
    const denied = await responseShape(await handle({ ...request, versionId: FIXTURE_VERSION_A }));
    const absent = await responseShape(await handle({ ...request, versionId: MISSING_DOCUMENT }));
    const invalid = await responseShape(
      await handle({ ...request, versionId: FIXTURE_VERSION_A, claimedByteSize: 0 }),
    );

    expect(denied).toEqual(absent);
    expect(invalid).toEqual(absent);
    expect(
      await responseShape(
        await createDraftWorkspaceHandler({
          tenantId: TENANT_A,
          clock: () => REQUEST_INSTANT,
        })({
          sessionToken: token(NO_SAVE_AUTHOR),
          documentId: FIXTURE_DOCUMENT_A,
          versionId: FIXTURE_VERSION_A,
        }),
      ),
    ).toEqual(absent);
    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const { rows } = await transaction.query<Record<string, unknown> & { count: number }>(
        `select count(*)::int as count from content_revision
          where tenant_id = $1 and document_version_id = $2`,
        [TENANT_A, FIXTURE_VERSION_A],
      );
      expect(rows).toEqual([{ count: countBefore }]);
    });
  });

  it("INV-AUTH-001: denies submission identically to a missing version", async () => {
    const handle = createSubmitContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const request = {
      sessionToken: token(NO_SUBMIT_AUTHOR),
      documentId: FIXTURE_DOCUMENT_A,
      revisionId: FIXTURE_REVISION_A,
      expectedVersionRowVersion: 1,
      expectedRevisionRowVersion: 1,
    };
    const denied = await responseShape(await handle({ ...request, versionId: FIXTURE_VERSION_A }));
    const absent = await responseShape(await handle({ ...request, versionId: MISSING_DOCUMENT }));
    const invalid = await responseShape(
      await handle({ ...request, versionId: FIXTURE_VERSION_A, expectedVersionRowVersion: 0 }),
    );

    expect(denied).toEqual(absent);
    expect(invalid).toEqual(absent);
    const workspaceResponse = await createDraftWorkspaceHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    })({
      sessionToken: token(NO_SUBMIT_AUTHOR),
      documentId: FIXTURE_DOCUMENT_A,
      versionId: FIXTURE_VERSION_A,
    });
    expect(workspaceResponse.status).toBe(200);
    expect(await workspaceResponse.json()).toMatchObject({ canSubmit: false });
    await asPrincipal(TENANT_A, FIXTURE_USER_A, async (transaction) => {
      const version = await transaction.query<
        Record<string, unknown> & { lifecycle_state: string }
      >(`select lifecycle_state from document_version where id = $1`, [FIXTURE_VERSION_A]);
      const revision = await transaction.query<
        Record<string, unknown> & { submitted_at: Date | null }
      >(`select submitted_at from content_revision where id = $1`, [FIXTURE_REVISION_A]);
      const approvals = await transaction.query<
        Record<string, unknown> & { runs: number; stages: number; tasks: number }
      >(
        `select
           (select count(*)::int from approval_run where content_revision_id = $1) as runs,
           (select count(*)::int
              from approval_stage stage
              join approval_run run
                on run.tenant_id = stage.tenant_id and run.id = stage.approval_run_id
             where run.content_revision_id = $1) as stages,
           (select count(*)::int
              from approval_task task
              join approval_stage stage
                on stage.tenant_id = task.tenant_id and stage.id = task.approval_stage_id
              join approval_run run
                on run.tenant_id = stage.tenant_id and run.id = stage.approval_run_id
             where run.content_revision_id = $1) as tasks`,
        [FIXTURE_REVISION_A],
      );
      expect(version.rows).toEqual([{ lifecycle_state: "DRAFT" }]);
      expect(revision.rows).toEqual([{ submitted_at: null }]);
      expect(approvals.rows).toEqual([{ runs: 0, stages: 0, tasks: 0 }]);
    });
  });

  it("INV-TEN-002: makes every document-addressed route return the same not-found for foreign ids", async () => {
    const foreignBytes = new TextEncoder().encode("Foreign save attempt.");
    const createVersionBoundary = createVersionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const saveBoundary = createContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
      storage: storageFor(foreignBytes),
    });
    const submitBoundary = createSubmitContentRevisionHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const versionFormBoundary = createVersionFormHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const workspaceBoundary = createDraftWorkspaceHandler({
      tenantId: TENANT_A,
      clock: () => REQUEST_INSTANT,
    });
    const responses = await Promise.all([
      versionFormBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_B,
      }),
      workspaceBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_B,
        versionId: FIXTURE_VERSION_B,
      }),
      createVersionBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_B,
        displayLabel: null,
        classificationCode: "INTERNAL",
        materiality: "MATERIAL",
        changeSummary: null,
      }),
      saveBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_B,
        versionId: FIXTURE_VERSION_B,
        ...finalizationRequest(foreignBytes, SECOND_REVISION, SECOND_SLOT),
      }),
      submitBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_B,
        versionId: FIXTURE_VERSION_B,
        revisionId: FIXTURE_REVISION_B,
        expectedVersionRowVersion: 1,
        expectedRevisionRowVersion: 1,
      }),
      submitBoundary({
        sessionToken: token(FULL_AUTHOR),
        documentId: FIXTURE_DOCUMENT_A,
        versionId: FIXTURE_VERSION_A,
        revisionId: FIXTURE_REVISION_B,
        expectedVersionRowVersion: 1,
        expectedRevisionRowVersion: 1,
      }),
    ]);
    const shapes = await Promise.all(responses.map(responseShape));

    expect(shapes[0]).toEqual(NOT_FOUND_SHAPE);
    expect(shapes).toEqual(shapes.map(() => shapes[0]));

    await asPrincipal(TENANT_B, FIXTURE_USER_B, async (transaction) => {
      const version = await transaction.query<
        Record<string, unknown> & { lifecycle_state: string; row_version: number }
      >(`select lifecycle_state, row_version from document_version where id = $1`, [
        FIXTURE_VERSION_B,
      ]);
      const revision = await transaction.query<
        Record<string, unknown> & { submitted_at: Date | null }
      >(`select submitted_at from content_revision where id = $1`, [FIXTURE_REVISION_B]);
      expect(version.rows).toEqual([{ lifecycle_state: "DRAFT", row_version: 1 }]);
      expect(revision.rows).toEqual([{ submitted_at: null }]);
    });
  });
});
