import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://chat:3000";
const viewports = [
  { width: 375, height: 667 },
  { width: 768, height: 1_024 },
  { width: 1_440, height: 900 },
];

const browser = await chromium.launch();

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: /Message/ }).focus();
    await page.keyboard.type("Keyboard check");
    await page.keyboard.press("Shift+Enter");

    const metrics = await page.evaluate(() => {
      const input = document.querySelector("#message-input");
      const send = document.querySelector("#send-button");
      const reset = document.querySelector("#reset-button");
      const root = document.documentElement;
      const inputRect = input.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      const resetRect = reset.getBoundingClientRect();

      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        activeElementId: document.activeElement?.id,
        inputValue: input.value,
        inputRect: inputRect.toJSON(),
        sendRect: sendRect.toJSON(),
        resetRect: resetRect.toJSON(),
      };
    });

    assert.equal(
      metrics.scrollWidth,
      metrics.clientWidth,
      `${viewport.width}px layout has horizontal overflow`,
    );
    assert.equal(
      metrics.activeElementId,
      "message-input",
      `${viewport.width}px composer cannot retain keyboard focus`,
    );
    assert.equal(
      metrics.inputValue,
      "Keyboard check\n",
      `${viewport.width}px Shift+Enter behaviour changed`,
    );

    for (const [name, rect] of [
      ["message input", metrics.inputRect],
      ["send button", metrics.sendRect],
      ["reset button", metrics.resetRect],
    ]) {
      assert.ok(rect.width > 0 && rect.height > 0, `${name} is hidden`);
      assert.ok(rect.left >= 0, `${name} is clipped on the left`);
      assert.ok(
        rect.right <= viewport.width,
        `${name} is clipped on the right at ${viewport.width}px`,
      );
      assert.ok(rect.top >= 0, `${name} is clipped above the viewport`);
      assert.ok(
        rect.bottom <= viewport.height,
        `${name} is clipped below the ${viewport.height}px viewport`,
      );
    }

    assert.deepEqual(
      browserErrors,
      [],
      `${viewport.width}px page emitted browser errors`,
    );

    console.log(
      `  [ok] ${viewport.width}x${viewport.height}: no overflow; composer, send, reset, and keyboard input available`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}

console.log("Browser-width checks passed.");
