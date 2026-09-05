// "自发 scroll 不解除 parked" 是 trackParked 闭包逻辑(到尾即认领、解除必须
// 用户驱动),无法纯函数测试,由 smoke 长答复跟随场景(:1790-1826)覆盖。
import { describe, expect, it } from "vitest";
import {
  isParkedAtTail,
  shouldPinTail,
  TAIL_PARK_THRESHOLD_PX,
  TAIL_PIN_GRACE_MS
} from "../src/client/workbench-tail.js";

describe("tail-pin 门禁", () => {
  it("贴底且无手势 → pin:流式输出停在尾部跟随到底", () => {
    const now = 10_000;
    expect(shouldPinTail({ parked: true, pointerHeld: false, lastDrivenAt: 0, now })).toBe(true);
  });

  it("指针按下 → 不 pin:长拖滚动条全程压制写回", () => {
    const now = 10_000;
    expect(shouldPinTail({ parked: true, pointerHeld: true, lastDrivenAt: 0, now })).toBe(false);
  });

  it("手势宽限内 → 不 pin:松开滚动条 600ms 内不抢位", () => {
    const now = 10_000;
    expect(shouldPinTail({ parked: true, pointerHeld: false, lastDrivenAt: now - 100, now })).toBe(false);
  });

  it("宽限边界 → 恢复 pin", () => {
    const now = 10_000;
    expect(shouldPinTail({ parked: true, pointerHeld: false, lastDrivenAt: now - TAIL_PIN_GRACE_MS, now })).toBe(true);
    expect(shouldPinTail({ parked: true, pointerHeld: false, lastDrivenAt: now - TAIL_PIN_GRACE_MS + 1, now })).toBe(false);
  });

  it("未贴底 → 不 pin:用户滚离后 resize 不拽回", () => {
    const now = 10_000;
    expect(shouldPinTail({ parked: false, pointerHeld: false, lastDrivenAt: 0, now })).toBe(false);
  });

  it("贴底阈值与旧行为一致", () => {
    expect(isParkedAtTail(1000, 891, 100)).toBe(false);
    expect(isParkedAtTail(1000, 892, 100)).toBe(true);
    expect(TAIL_PARK_THRESHOLD_PX).toBe(8);
  });
});
