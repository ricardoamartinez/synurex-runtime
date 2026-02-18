import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "synurex",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "synurex", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "synurex", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "synurex", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "synurex", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "synurex", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "synurex", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "synurex", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "synurex", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".synurex-dev");
    expect(env.SYNUREX_PROFILE).toBe("dev");
    expect(env.SYNUREX_STATE_DIR).toBe(expectedStateDir);
    expect(env.SYNUREX_CONFIG_PATH).toBe(path.join(expectedStateDir, "synurex.json"));
    expect(env.SYNUREX_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      SYNUREX_STATE_DIR: "/custom",
      SYNUREX_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.SYNUREX_STATE_DIR).toBe("/custom");
    expect(env.SYNUREX_GATEWAY_PORT).toBe("19099");
    expect(env.SYNUREX_CONFIG_PATH).toBe(path.join("/custom", "synurex.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("synurex doctor --fix", {})).toBe("synurex doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("synurex doctor --fix", { SYNUREX_PROFILE: "default" })).toBe(
      "synurex doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("synurex doctor --fix", { SYNUREX_PROFILE: "Default" })).toBe(
      "synurex doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("synurex doctor --fix", { SYNUREX_PROFILE: "bad profile" })).toBe(
      "synurex doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("synurex --profile work doctor --fix", { SYNUREX_PROFILE: "work" }),
    ).toBe("synurex --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("synurex --dev doctor", { SYNUREX_PROFILE: "dev" })).toBe(
      "synurex --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("synurex doctor --fix", { SYNUREX_PROFILE: "work" })).toBe(
      "synurex --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("synurex doctor --fix", { SYNUREX_PROFILE: "  jbSynurex  " })).toBe(
      "synurex --profile jbSynurex doctor --fix",
    );
  });

  it("handles command with no args after Synurex", () => {
    expect(formatCliCommand("synurex", { SYNUREX_PROFILE: "test" })).toBe(
      "synurex --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm Synurex doctor", { SYNUREX_PROFILE: "work" })).toBe(
      "pnpm Synurex --profile work doctor",
    );
  });
});
