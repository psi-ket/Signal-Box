/**
 * Browser end-to-end: three isolated headless Chrome/Edge profiles use the real UI against
 * the real hub with the in-process host runner. Agents are the MOCK provider (scripted).
 * Requires a built client (`npm run build`) and a local Chrome or Edge; set COLAB_BROWSER
 * to override. Screenshots go to COLAB_SCREENSHOTS if set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createApp, type App } from "../server/app.ts";
import { silentLogger } from "../server/log.ts";
import { createFixture } from "../scripts/setup-demo.ts";
import { testConfig } from "./helpers.ts";

const BROWSERS = [
  process.env.COLAB_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];
const executablePath = BROWSERS.find((p) => existsSync(p));
const dist = path.resolve("web/dist");
const shots = process.env.COLAB_SCREENSHOTS;
const canRun = !!executablePath && existsSync(path.join(dist, "index.html"));

describe.skipIf(!canRun)("browser workflow (accounts, host runner, mock agents)", { timeout: 90_000 }, () => {
  let app: App;
  let browser: Browser;
  let url: string;
  let repo: string;
  let roomPath = "";
  const pages: Record<string, Page> = {};

  const shot = async (page: Page, file: string) => {
    if (shots) await page.screenshot({ path: path.join(shots, file) as `${string}.png`, fullPage: file.includes("landing") });
  };
  const text = (page: Page) => page.evaluate(() => document.body.innerText);
  const has = async (page: Page, s: string, timeout = 15_000) => {
    try {
      await page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, s);
    } catch {
      throw new Error(`text not found: "${s}". Page shows:\n${(await text(page)).slice(0, 800)}`);
    }
  };
  const clickText = async (page: Page, tag: string, label: string) => {
    const sel = `xpath/.//${tag}[normalize-space()='${label}']`;
    await page.waitForSelector(sel, { timeout: 10_000 });
    const [el] = await page.$$(sel);
    await el!.click();
  };

  async function signUp(name: string) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on("pageerror", (e) => console.error(`[${name}] page error`, e));
    await page.goto(`${url}/register`);
    await page.waitForSelector("form.auth");
    const inputs = await page.$$("form.auth input");
    await inputs[0]!.type(name);
    await inputs[1]!.type("correct-horse-battery");
    await inputs[2]!.type("correct-horse-battery");
    await page.click("form.auth button[type=submit]");
    await has(page, "~/rooms");
    pages[name] = page;
    return page;
  }

  async function spawn(page: Page, demoTitle: string) {
    await page.select(".newsession select", "mock");
    await clickText(page, "button", demoTitle);
    await page.click(".newsession button[type=submit]");
  }

  async function vote(page: Page, label: string) {
    const sel = `xpath/.//aside[contains(@class,'dock')]//section[contains(@class,'ballot--open')]//button[.//span[@class='opt__label' and normalize-space()='${label}']]`;
    await page.waitForSelector(sel, { timeout: 10_000 });
    const [btn] = await page.$$(sel);
    await btn!.click();
  }

  beforeAll(async () => {
    repo = path.join(await mkdtemp(path.join(tmpdir(), "colab-browser-")), "todo-app");
    await createFixture(repo);
    app = await createApp({ config: await testConfig({ webDist: dist, hostRunner: true, voteMs: 20_000, ownerWindowMs: 10_000 }), log: silentLogger, skipDiscovery: true });
    url = `http://127.0.0.1:${await app.listen()}`;
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-first-run", "--mute-audio"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  });

  it("shows the landing page and sends signed-out visitors to sign in", async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url);
    await has(page, "Decide together.");
    await page.waitForSelector(".replay .mini-vote", { timeout: 10_000 }); // the replay animates a vote
    await shot(page, "01-landing.png");
    await page.goto(`${url}/rooms`);
    await page.waitForSelector("form.auth");
    expect(page.url()).toContain("/login?next=%2Frooms");
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(url);
    await has(page, "Decide together.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "02-landing-mobile.png");
    await ctx.close();
  });

  it("registers accounts; the first creates a password-protected room from a Git URL", async () => {
    const ana = await signUp("ana");
    await has(ana, "site admin");
    await signUp("bob");
    await signUp("cara");
    await ana.type("input[placeholder='hackathon-backend']", "todo-squad");
    await ana.type("input[placeholder*='github.com']", repo);
    await ana.type(".create input[type=password]", "pw123");
    await ana.click(".create button[type=submit]");
    await has(ana, "~/todo-squad");
    roomPath = new URL(ana.url()).pathname;
    expect(roomPath).toMatch(/^\/rooms\/[0-9a-f]{10}$/);
    await shot(ana, "03-room-empty.png");
  });

  it("teammates join by link (password prompt) and from the room list", async () => {
    const bob = pages.bob!;
    await bob.goto(url + roomPath);
    await bob.waitForSelector("#room-pw");
    await bob.type("#room-pw", "wrong");
    await bob.click(".pw--big button[type=submit]");
    await has(bob, "wrong room password");
    await bob.waitForFunction(() => (document.querySelector("#room-pw") as HTMLInputElement | null)?.value === "");
    await bob.type("#room-pw", "pw123");
    await bob.click(".pw--big button[type=submit]");
    await has(bob, "~/todo-squad");

    const cara = pages.cara!;
    await clickText(cara, "a", "join");
    await cara.waitForSelector("#room-pw");
    await cara.type("#room-pw", "pw123");
    await cara.click(".pw--big button[type=submit]");
    await has(cara, "~/todo-squad");
    await has(pages.ana!, "3/8 online");
  });

  it("chat, a team vote on a real runner, and Markdown output", async () => {
    const { ana, bob, cara } = pages as Record<string, Page>;
    await bob!.type("#chat-input", "I'll take storage");
    await bob!.keyboard.press("Enter");
    await has(ana!, "I'll take storage");

    await spawn(ana!, "Storage");
    for (const p of [ana!, bob!, cara!]) await p.waitForSelector(".ballot--open", { timeout: 20_000 });
    await shot(bob!, "04-vote-open.png");
    await vote(bob!, "SQLite");
    await vote(cara!, "SQLite");
    await vote(ana!, "PostgreSQL");
    for (const p of [ana!, bob!, cara!]) await has(p, "Majority vote");
    await has(ana!, "Added src/db.js", 20_000);
    expect(await text(bob!)).toContain("Only ana can prompt this agent.");
    expect(await text(bob!)).toContain("on host");

    await ana!.type(".prompt input", "say ## Summary **SQLite chosen** with `db.js`");
    await ana!.keyboard.press("Enter");
    await bob!.waitForSelector(".t-text.md:not(.t-text--live) h2 code", { timeout: 15_000 });
    expect(await bob!.$eval(".md h2 strong", (e) => e.textContent)).toBe("SQLite chosen");
  });

  it("amber overlap and a red verified conflict in the signal strip", async () => {
    const { ana, bob, cara } = pages as Record<string, Page>;
    await spawn(bob!, "Rebrand: TaskForge");
    await spawn(cara!, "Rebrand: TodoPro");
    await ana!.waitForSelector(".lamp--conflict", { timeout: 30_000 });
    await ana!.waitForFunction(() => document.querySelectorAll(".lamp--overlap, .lamp--conflict").length === 3, { timeout: 20_000 });
    const t = await text(ana!);
    expect(t).toMatch(/Conflict\s+Rebrand: (TaskForge ✕ Rebrand: TodoPro|TodoPro ✕ Rebrand: TaskForge): src\/config\.js/);
    expect(t).toMatch(/Shared file README\.md \(.*Storage.*\)\. Merges cleanly so far\./);
    await shot(ana!, "05-drift.png");
  });

  it("admin ends the room; everyone sees the recap; sign out works", async () => {
    const { ana, cara } = pages as Record<string, Page>;
    await clickText(ana!, "button", "end room");
    await clickText(ana!, "button", "confirm: stop agents + recap");
    await cara!.waitForSelector(".recap", { timeout: 30_000 });
    expect(await text(cara!)).toMatch(/A src\/db\.js/);
    await shot(cara!, "06-recap.png");
    await clickText(cara!, "button", "Close");
    await clickText(cara!, "a", "← rooms");
    await has(cara!, "~/rooms");
    await clickText(cara!, "button", "sign out");
    await has(cara!, "Decide together.");
  });
});
