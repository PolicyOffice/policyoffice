import { expect, test } from "@playwright/test";

test("INV-AUTH-004 / INV-AUTH-014 / INV-TEN-002: sign in, see the register, and sign out", async ({
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

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("http://localhost:3000/sign-in");
  await page.goto("/documents");
  await expect(page.locator("body")).toContainText('{"error":"not_found"}');
  const afterPath = testInfo.outputPath("signed-out.png");
  await page.screenshot({ path: afterPath, fullPage: true });
  await testInfo.attach("signed-out", { path: afterPath, contentType: "image/png" });
});
