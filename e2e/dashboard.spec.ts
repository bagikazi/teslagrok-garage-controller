import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Kullanıcı adı").fill("owner");
  await page.getByLabel("Şifre", { exact: true }).fill("change-me-now");
  await page.getByRole("button", { name: "Giriş yap" }).click();
}

test("owner can sign in and see the live garage dashboard", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Kapı kapalı" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Kapıyı aç/ })).toBeVisible();
  await page.getByRole("button", { name: /^Sensörler/ }).click();
  await expect(page.getByText("ESP32-S3 kontrol kartı")).toBeVisible();
});

test("the door dial needs a hold, not a tap, to send a command", async ({ page }) => {
  await signIn(page);
  const dial = page.getByRole("button", { name: /Kapıyı aç/ });
  await dial.click();
  await expect(page.getByText("Basılı tutun")).toBeVisible();
  await expect(page.getByText(/komutu gönderildi/)).toHaveCount(0);
});
