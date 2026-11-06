/**
 * The control page's settings must be safe against arbitrary JSON: an operator
 * typing a 400-day session or a negative one, or a malformed row written by
 * hand, must never reach the mobile app. These tests pin the clamping rules and
 * the "unset field keeps its default" behaviour, since a regression here would
 * silently shorten every representative's session or drop a notification.
 */
import { describe, it, expect } from "vitest";
import {
  normaliseFieldOpsSettings,
  FIELD_OPS_DEFAULT_SETTINGS,
} from "../../modules/field-ops/service";

describe("normaliseFieldOpsSettings", () => {
  it("returns the defaults for null/undefined/garbage input", () => {
    expect(normaliseFieldOpsSettings(null)).toEqual(FIELD_OPS_DEFAULT_SETTINGS);
    expect(normaliseFieldOpsSettings(undefined)).toEqual(FIELD_OPS_DEFAULT_SETTINGS);
    expect(normaliseFieldOpsSettings("nonsense")).toEqual(FIELD_OPS_DEFAULT_SETTINGS);
    expect(normaliseFieldOpsSettings(42)).toEqual(FIELD_OPS_DEFAULT_SETTINGS);
  });

  it("keeps a valid override and fills the rest from defaults", () => {
    const out = normaliseFieldOpsSettings({ appNameAr: "اسم مخصص" });
    expect(out.appNameAr).toBe("اسم مخصص");
    expect(out.appNameEn).toBe(FIELD_OPS_DEFAULT_SETTINGS.appNameEn);
    expect(out.sessionDays).toBe(FIELD_OPS_DEFAULT_SETTINGS.sessionDays);
  });

  it("ignores a blank name so the app never renders an empty title", () => {
    expect(normaliseFieldOpsSettings({ appNameAr: "   " }).appNameAr).toBe(
      FIELD_OPS_DEFAULT_SETTINGS.appNameAr,
    );
  });

  it("clamps sessionDays to the 1–365 range and rounds fractions", () => {
    expect(normaliseFieldOpsSettings({ sessionDays: 0 }).sessionDays).toBe(1);
    expect(normaliseFieldOpsSettings({ sessionDays: -5 }).sessionDays).toBe(1);
    expect(normaliseFieldOpsSettings({ sessionDays: 9999 }).sessionDays).toBe(365);
    expect(normaliseFieldOpsSettings({ sessionDays: 12.6 }).sessionDays).toBe(13);
  });

  it("rejects a non-finite sessionDays rather than storing NaN", () => {
    expect(normaliseFieldOpsSettings({ sessionDays: Number.NaN }).sessionDays).toBe(
      FIELD_OPS_DEFAULT_SETTINGS.sessionDays,
    );
    expect(normaliseFieldOpsSettings({ sessionDays: Number.POSITIVE_INFINITY }).sessionDays).toBe(
      FIELD_OPS_DEFAULT_SETTINGS.sessionDays,
    );
    expect(normaliseFieldOpsSettings({ sessionDays: "30" }).sessionDays).toBe(
      FIELD_OPS_DEFAULT_SETTINGS.sessionDays,
    );
  });

  it("only accepts real booleans for the toggles", () => {
    const on = normaliseFieldOpsSettings({
      autoAssignOnDispatch: false,
      notifyOnAssignment: false,
      notifyOnDeliveryAvailable: false,
      maintenanceMode: true,
    });
    expect(on.autoAssignOnDispatch).toBe(false);
    expect(on.notifyOnAssignment).toBe(false);
    expect(on.notifyOnDeliveryAvailable).toBe(false);
    expect(on.maintenanceMode).toBe(true);

    // Truthy non-booleans must not flip a switch.
    const coerced = normaliseFieldOpsSettings({
      autoAssignOnDispatch: "yes",
      notifyOnAssignment: 1,
      maintenanceMode: "true",
    });
    expect(coerced.autoAssignOnDispatch).toBe(true); // default kept
    expect(coerced.notifyOnAssignment).toBe(true); // default kept
    expect(coerced.maintenanceMode).toBe(false); // default kept
  });

  it("truncates over-long strings instead of storing them whole", () => {
    const out = normaliseFieldOpsSettings({
      appNameAr: "ا".repeat(200),
      welcomeMessageAr: "ب".repeat(1000),
      supportPhone: "9".repeat(100),
    });
    expect(out.appNameAr.length).toBe(60);
    expect(out.welcomeMessageAr.length).toBe(300);
    expect(out.supportPhone.length).toBe(30);
  });
});
