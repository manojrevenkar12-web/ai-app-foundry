import { expect, test } from "@playwright/test";
import { shoot, signIn, watch } from "./helpers";

test("the console is served with a strict content security policy", async ({ page }) => {
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
});

test("signing in shows the apps shared with you, and only those", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Foundry" })).toBeVisible();
  await shoot(page, "01-sign-in");
  await signIn(page, "jonas");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  const shared = page.getByRole("list", { name: "Apps shared with you" });
  await expect(shared.getByRole("heading", { name: "Fault triage assistant" })).toBeVisible();
  await expect(shared.getByRole("heading", { name: "Monthly revenue brief" })).toHaveCount(0);
  // a user is not a builder: no Build, Reviews or Tokens
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Apps"]);
  await shoot(page, "02-catalog");
  expect(problems).toEqual([]);
});

test("an assistant answers from the data the person may see and shows its sources", async ({ page }) => {
  const problems = watch(page);
  await signIn(page, "jonas", "/apps/fault-triage");
  await expect(page.getByRole("heading", { name: "What this app can reach" })).toBeVisible();
  await page.getByRole("button", { name: "Why is DE*EDR*E1001 faulted?" }).click();
  const answer = page.locator(".msg--assistant").last();
  await expect(answer).toContainText("fault model ranks");
  await expect(answer.getByLabel("Sources")).toContainText("faults.diagnose");
  await shoot(page, "03-assistant");
  expect(problems).toEqual([]);
});

test("a write waits for the person, and happens once they confirm", async ({ page }) => {
  await signIn(page, "jonas", "/apps/fault-triage");
  // a ticket Jonas may not see: the platform refuses the write when he confirms it
  await page.getByLabel("Ticket", { exact: true }).fill("T-9999999");
  await page.getByLabel("Note", { exact: true }).fill("Test");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("FORBIDDEN_FOR_VIEWER");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled. Nothing was changed.")).toBeVisible();
  // a German ticket (the simulated world is generated from a fixed seed)
  await page.getByLabel("Ticket", { exact: true }).fill("T-4003");
  await page.getByLabel("Note", { exact: true }).fill("Residual current trip; reset and test the RCD.");
  await page.getByRole("button", { name: "Add note" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("until you confirm");
  await expect(dialog).toContainText("Residual current trip");
  await shoot(page, "04-confirm-write");
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText(/^Done: /)).toBeVisible();
});

test("people outside the commercial group cannot open a confidential app", async ({ page }) => {
  await signIn(page, "jonas", "/apps/revenue-brief");
  await expect(page.getByRole("alert")).toContainText("Not found");
});

test("a builder drafts, checks and tries an app before submitting it", async ({ page }) => {
  const problems = watch(page);
  await signIn(page, "mara", "/build");
  await page.getByRole("button", { name: /private notebook/ }).click();
  await page.getByRole("button", { name: "Draft the app" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Passes the checks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Publishes without a reviewer" })).toBeVisible();
  // try it: the preview runs as the builder
  await page.getByLabel("Note", { exact: true }).fill("Check DE*EDR*E1001 at the start of the shift");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("button", { name: "Submit version" })).toBeVisible();
  await shoot(page, "05-build");
  // an edit makes the check stale until it runs again
  await page.getByRole("tab", { name: "Code" }).click();
  await page
    .locator("textarea.code")
    .fill("export async function save() { return eval('1'); }\nexport async function recent() { return {}; }");
  await page.getByRole("button", { name: "Run the checks" }).click();
  await expect(page.getByRole("button", { name: "Submit version" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a reviewer sees the reach, the findings and the code, and approves the exact bundle", async ({ browser }) => {
  // Sofia submits a company-wide app (tier 1: a second builder must approve it)
  const sofia = await browser.newPage();
  await signIn(sofia, "sofia");
  const h = { "x-foundry-request": "1" };
  const draft = await (
    await sofia.request.post("/v1/builder/draft", { headers: h, data: { description: "Show the status of charge points in a city" } })
  ).json();
  const id = `city-status-${Date.now().toString(36)}`;
  const bundle = { ...draft.bundle, manifest: { ...draft.bundle.manifest, id, name: "City status", audience: { kind: "company" } } };
  const sub = await (await sofia.request.post("/v1/apps", { headers: h, data: { bundle } })).json();
  expect(sub).toMatchObject({ status: "in_review", number: 1 });

  const page = await browser.newPage();
  await signIn(page, "lea", "/reviews");
  await page.getByRole("link", { name: /City status/ }).click();
  await expect(page.getByRole("heading", { name: "What it will reach" })).toBeVisible();
  await expect(page.getByText("open to the whole company")).toBeVisible();
  await expect(page.locator("pre[data-file='handlers.js']")).toContainText("ctx.llm.chat");
  await shoot(page, "06-review");
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(page.getByRole("heading", { name: "Reviews" })).toBeVisible();

  await sofia.goto(`/apps/${id}/manage`);
  await expect(sofia.getByRole("row", { name: /Lea Hoffmann approved/ })).toBeVisible();
  await sofia.getByRole("button", { name: "Publish" }).click();
  await expect(sofia.getByRole("row", { name: /live/ })).toBeVisible();
  await shoot(sofia, "07-manage");
});

test("operations shows usage and an intact audit chain", async ({ page }) => {
  await signIn(page, "lea", "/ops");
  await expect(page.getByRole("status").filter({ hasText: "Hash chain intact" })).toBeVisible();
  await shoot(page, "08-operations");
});

test("a token for a coding tool is shown once", async ({ page }) => {
  await signIn(page, "mara", "/tokens");
  await page.getByRole("button", { name: "Create token" }).click();
  const secret = page.locator(".secret > code");
  await expect(secret).toContainText("fdy_");
  await shoot(page, "09-tokens");
  await page.reload();
  await expect(page.locator(".secret")).toHaveCount(0);
  await expect(page.getByText("Claude Code on my laptop").first()).toBeVisible();
});
