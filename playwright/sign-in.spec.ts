import { expect, test } from "@playwright/test";
import { buildFixtureSet } from "../packages/db/src/fixtures";

const foreignTenant = buildFixtureSet("test").tenants[1];
const foreignDocumentId = foreignTenant?.documents[0]?.id;
const foreignVersionId = foreignTenant?.documents[0]?.draftVersionId;
if (!foreignDocumentId || !foreignVersionId) {
  throw new Error("the browser fixture requires a foreign document and draft version");
}

test("INV-AUTH-001 / INV-AUTH-004 / INV-AUTH-014 / INV-DOC-007 / INV-TEN-002 / INV-VER-001 / INV-VER-002: sign in, author and submit a policy, and sign out", async ({
  page,
}, testInfo) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to PolicyOffice" })).toBeVisible();
  const beforePath = testInfo.outputPath("sign-in.png");
  await page.screenshot({ path: beforePath, fullPage: true });
  await testInfo.attach("sign-in", { path: beforePath, contentType: "image/png" });

  await page.getByLabel("Email").fill("a-admin@example.test");
  await page.getByLabel("Password").fill("policyoffice-test");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.getByRole("heading", { name: "Document register" })).toBeVisible();
  await expect(page.getByText("Test Tenant Alpha Policy Framework")).toBeVisible();
  const registerPath = testInfo.outputPath("document-register.png");
  await page.screenshot({ path: registerPath, fullPage: true });
  await testInfo.attach("document-register", { path: registerPath, contentType: "image/png" });

  const foreignDocumentResponse = await page.goto(`/author/documents/${foreignDocumentId}`);
  expect(foreignDocumentResponse?.status()).toBe(404);
  const foreignVersionResponse = await page.goto(
    `/author/documents/${foreignDocumentId}/versions/${foreignVersionId}`,
  );
  expect(foreignVersionResponse?.status()).toBe(404);
  await page.goto("/");

  await page.getByRole("link", { name: "Create document" }).click();
  await expect(page.getByRole("heading", { name: "Create document" })).toBeVisible();
  await page.getByLabel("Document code").fill("POL-E2E-033");
  await page.getByLabel("Title").fill("Browser Author Path Policy");
  await page.getByRole("button", { name: "Create document" }).click();

  await expect(page.getByRole("heading", { name: "Start version" })).toBeVisible();
  await expect(page.getByText("POL-E2E-033 Browser Author Path Policy — PLANNED")).toBeVisible();
  const documentAuthorUrl = page.url();
  const createdPath = testInfo.outputPath("document-created.png");
  await page.screenshot({ path: createdPath, fullPage: true });
  await testInfo.attach("document-created", { path: createdPath, contentType: "image/png" });

  await page.getByLabel("Display label").fill("1.0");
  await page.getByLabel("Change summary").fill("Initial browser-authored draft");
  await page.getByRole("button", { name: "Start version" }).click();

  await expect(page.getByRole("heading", { name: "Draft workspace" })).toBeVisible();
  const workspaceUrl = page.url();
  await page.getByLabel("Candidate policy file").setInputFiles({
    name: "browser-policy-v1.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("First browser draft."),
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeVisible();
  const firstRevisionUrl = page.url();

  await page.getByLabel("Candidate policy file").setInputFiles({
    name: "browser-policy-v2.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Second browser draft selected for review."),
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeVisible();
  expect(page.url()).not.toBe(firstRevisionUrl);
  const draftPath = testInfo.outputPath("draft-saved.png");
  await page.screenshot({ path: draftPath, fullPage: true });
  await testInfo.attach("draft-saved", { path: draftPath, contentType: "image/png" });

  await page.goto(firstRevisionUrl);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("heading", { name: "Version submitted" })).toBeVisible();
  await expect(page.getByText("The selected revision is frozen")).toBeVisible();
  const submittedPath = testInfo.outputPath("version-submitted.png");
  await page.screenshot({ path: submittedPath, fullPage: true });
  await testInfo.attach("version-submitted", { path: submittedPath, contentType: "image/png" });

  await page.goto("/");
  await expect(page.getByText("Browser Author Path Policy")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("http://localhost:3000/sign-in");
  await page.goto(documentAuthorUrl);
  await expect(page).toHaveURL("http://localhost:3000/sign-in");
  await page.goto(workspaceUrl);
  await expect(page).toHaveURL("http://localhost:3000/sign-in");
  await page.goto("/documents");
  await expect(page.locator("body")).toContainText('{"error":"not_found"}');
  const afterPath = testInfo.outputPath("signed-out.png");
  await page.screenshot({ path: afterPath, fullPage: true });
  await testInfo.attach("signed-out", { path: afterPath, contentType: "image/png" });
});
