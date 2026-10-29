import type { Page } from "@playwright/test";

/** Signs in through the development identity provider (the real code flow with PKCE). */
export const signIn = async (page: Page, persona: string, returnTo = "/") => {
  await page.goto(`/auth/login?login_hint=${persona}&returnTo=${encodeURIComponent(returnTo)}`);
  await page.waitForLoadState("networkidle");
};

/** Collects CSP violations and page errors; a strict CSP must not break anything. */
export const watch = (page: Page) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content.Security.Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  return problems;
};

export const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `../../docs/screenshots/${name}.png`, fullPage: true });
};
