import { expect, test } from "@playwright/test";
import { APPROVAL_DIGEST, APPROVAL_TASK_ID } from "./global-setup";

test("INV-APR-001 / INV-AUTH-001 / INV-TEN-002 / INV-TIME-001: approver reviews the exact candidate before approving", async ({
  page,
}, testInfo) => {
  await page.goto("/approvals");
  await expect(page).toHaveURL("http://localhost:3000/sign-in");

  await page.getByLabel("Email").fill("a-admin@example.test");
  await page.getByLabel("Password").fill("policyoffice-test");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Approval inbox" }).click();

  await expect(page.getByRole("heading", { name: "Approval inbox" })).toBeVisible();
  await expect(page.locator("main > ul > li")).toHaveCount(1);
  await expect(page.getByText("browser-approval-1")).toBeVisible();
  await expect(page.getByText(/2026-01-01T00:05:00.000Z \(UTC\)/)).toBeVisible();
  const inboxPath = testInfo.outputPath("approval-inbox.png");
  await page.screenshot({ path: inboxPath, fullPage: true });
  await testInfo.attach("approval-inbox", { path: inboxPath, contentType: "image/png" });

  await page.getByRole("link", { name: /browser-approval-1/ }).click();
  await expect(page).toHaveURL(`http://localhost:3000/approvals/${APPROVAL_TASK_ID}`);
  await expect(page.getByText(APPROVAL_DIGEST, { exact: true })).toBeVisible();
  await expect(
    page.getByText("c6000000-0000-0000-0042-000000000001", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Browser candidate submitted by a distinct author")).toBeVisible();
  await expect(page.getByText(/Organisational units: Head Office \(HEAD_OFFICE\)/)).toBeVisible();
  await expect(page.getByText("No prior decisions.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  const governingOrder = await page
    .locator('section[aria-labelledby="candidate-details"]')
    .evaluate((details) => {
      const prior = document.querySelector('section[aria-labelledby="prior-decisions"]');
      const controls = document.querySelector('section[aria-labelledby="decision-controls"]');
      if (!prior || !controls) return false;
      return (
        Boolean(details.compareDocumentPosition(prior) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        Boolean(prior.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
  expect(governingOrder).toBe(true);
  const candidatePath = testInfo.outputPath("approval-candidate.png");
  await page.screenshot({ path: candidatePath, fullPage: true });
  await testInfo.attach("approval-candidate", { path: candidatePath, contentType: "image/png" });

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page).toHaveURL("http://localhost:3000/approvals?recorded=APPROVE");
  await expect(page.getByRole("status")).toHaveText("Decision recorded: APPROVE");
  await expect(page.getByText("browser-approval-1")).toHaveCount(0);
  const recordedPath = testInfo.outputPath("approval-recorded.png");
  await page.screenshot({ path: recordedPath, fullPage: true });
  await testInfo.attach("approval-recorded", { path: recordedPath, contentType: "image/png" });

  await page.context().clearCookies();
  await page.goto(`/approvals/${APPROVAL_TASK_ID}`);
  await expect(page).toHaveURL("http://localhost:3000/sign-in");
});
