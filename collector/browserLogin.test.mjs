import { describe, expect, it, vi } from "vitest";
import { readLoginQrCode } from "./browserLogin.mjs";

const page = value => ({ isClosed: () => false, reveal: vi.fn(), evaluate: vi.fn(async () => value) });

describe("login QR pass-through", () => {
  it("passes only image data URLs and trims the hint", async () => {
    const hint = "使用原设备扫码：为保障账号安全，请使用「抖音 APP」扫码验证，以确保为本人操作".repeat(2);
    expect(await readLoginQrCode(page({ image: "data:image/jpeg;base64,iVBORw0KGgo=", hint }))).toEqual({ image: "data:image/jpeg;base64,iVBORw0KGgo=", hint: hint.slice(0, 60) });
    expect(await readLoginQrCode(page({ image: "https://example.org/qr.png", hint: "" }))).toBeNull();
    expect(await readLoginQrCode(page(null))).toBeNull();
  });

  it("shows the hidden window when a second verification has no QR code", async () => {
    const verifying = page({ verifyWithoutCode: true });
    expect(await readLoginQrCode(verifying)).toBeNull();
    expect(verifying.reveal).toHaveBeenCalledOnce();
  });
});
