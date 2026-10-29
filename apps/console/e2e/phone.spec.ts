import { expect, test } from "@playwright/test";
import { shoot, signIn } from "./helpers";

test("works on a phone without sideways scrolling", async ({ page }) => {
  await signIn(page, "jonas", "/apps/site-snapshot");
  await page.getByLabel("City", { exact: true }).fill("Essen");
  await page.getByRole("button", { name: "Show charge points" }).click();
  await expect(page.locator(".stats")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shoot(page, "10-phone");
});
