import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "synurex", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "synurex", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "synurex", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "synurex", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "synurex", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "synurex", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "synurex", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "synurex"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "synurex", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "synurex", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "synurex", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "synurex", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "synurex", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "synurex", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "synurex", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "synurex", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "synurex", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "synurex", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "synurex", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "synurex", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "synurex", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "synurex", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node", "synurex", "status"],
    });
    expect(nodeArgv).toEqual(["node", "synurex", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node-22", "synurex", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "synurex", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node-22.2.0.exe", "synurex", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "synurex", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node-22.2", "synurex", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "synurex", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node-22.2.exe", "synurex", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "synurex", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["/usr/bin/node-22.2.0", "synurex", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "synurex", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["nodejs", "synurex", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "synurex", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["node-dev", "synurex", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "synurex", "node-dev", "synurex", "status"]);

    const directArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["synurex", "status"],
    });
    expect(directArgv).toEqual(["node", "synurex", "status"]);

    const bunArgv = buildParseArgv({
      programName: "synurex",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "synurex",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "synurex", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "synurex", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "synurex", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "synurex", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "synurex", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "synurex", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "synurex", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "synurex", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
