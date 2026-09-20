import { expect, test } from "@playwright/test";
import {
  READER_ATTACHMENT_DIGEST,
  READER_DOCUMENT_ID,
  READER_DRAFT_VERSION_ID,
  READER_EFFECTIVE_VERSION_ID,
} from "./global-setup";

test("INV-EFF-001 / INV-AUTH-001 / INV-VER-003: reader sees the effective release but not a draft", async ({
  page,
}, testInfo) => {
  await page.goto(`/documents/${READER_DOCUMENT_ID}`);
  await expect(page).toHaveURL("http://localhost:3000/sign-in");

  await page.getByLabel("Email").fill("a-admin@example.test");
  await page.getByLabel("Password").fill("policyoffice-test");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /POL-READER Browser Reader Policy/ }).click();

  await expect(
    page.getByRole("heading", { name: "POL-READER Browser Reader Effective Policy" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Version 1.0 governs");
  await expect(page.getByText("Internal (INTERNAL)")).toBeVisible();
  await expect(page.getByText("For internal use unless separately authorised.")).toBeVisible();
  await expect(page.getByText("Test Tenant Alpha Administrator")).toBeVisible();
  await expect(page.getByText("Head Office (HEAD_OFFICE)")).toBeVisible();
  await expect(page.getByText("2026-01-01T00:00:00.000Z (UTC)")).toBeVisible();
  await expect(page.getByText(/reader-policy\.pdf — application\/pdf, 2048 bytes/)).toBeVisible();
  await expect(page.getByText(READER_ATTACHMENT_DIGEST, { exact: true })).toBeVisible();

  const visibleReaderText = (await page.locator("main").innerText()).toLowerCase();
  expect(visibleReaderText).not.toMatch(/\bcurrent\b/);
  expect(visibleReaderText).not.toContain("materiality");
  expect(visibleReaderText).not.toContain("variant");
  expect(visibleReaderText).not.toContain("approval stage");
  expect(visibleReaderText).not.toContain("approval mechanics");

  const recordPath = testInfo.outputPath("reader-effective-record.png");
  await page.screenshot({ path: recordPath, fullPage: true });
  await testInfo.attach("reader-effective-record", {
    path: recordPath,
    contentType: "image/png",
  });

  await page.getByRole("link", { name: "Effective policy" }).click();
  await expect(page).toHaveURL(`http://localhost:3000/documents/${READER_DOCUMENT_ID}/effective`);
  await expect(page.getByRole("paragraph").filter({ hasText: /^Effective policy$/ })).toBeVisible();
  await page.getByRole("link", { name: "Exact version" }).click();
  await expect(page).toHaveURL(
    `http://localhost:3000/documents/${READER_DOCUMENT_ID}/versions/${READER_EFFECTIVE_VERSION_ID}`,
  );
  await expect(page.getByRole("status")).toHaveText("This version governs now.");

  const draftResponse = await page.goto(
    `/documents/${READER_DOCUMENT_ID}/versions/${READER_DRAFT_VERSION_ID}`,
  );
  expect(draftResponse?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
});
