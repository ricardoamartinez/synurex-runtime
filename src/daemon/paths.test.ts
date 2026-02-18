import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".synurex"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", SYNUREX_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".synurex-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", SYNUREX_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".synurex"));
  });

  it("uses SYNUREX_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", SYNUREX_STATE_DIR: "/var/lib/Synurex" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/Synurex"));
  });

  it("expands ~ in SYNUREX_STATE_DIR", () => {
    const env = { HOME: "/Users/test", SYNUREX_STATE_DIR: "~/Synurex-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/Synurex-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { SYNUREX_STATE_DIR: "C:\\State\\Synurex" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\Synurex");
  });
});
