import { describe, it, expect } from "vitest";
import { parseArgv, UsageError } from "../src/argv.js";

describe("parseArgv", () => {
  it("returns the inner command after --", () => {
    const result = parseArgv(["node", "enclave", "--", "pi"]);
    expect(result.innerCommand).toEqual(["pi"]);
  });

  it("passes through everything after -- including flags", () => {
    const result = parseArgv(["node", "enclave", "--", "pi", "--foo", "bar"]);
    expect(result.innerCommand).toEqual(["pi", "--foo", "bar"]);
  });

  it("throws UsageError when -- is missing", () => {
    expect(() => parseArgv(["node", "enclave", "pi"])).toThrowError(UsageError);
  });

  it("throws UsageError when nothing follows --", () => {
    expect(() => parseArgv(["node", "enclave", "--"])).toThrowError(UsageError);
  });

  it("rejects any enclave args before -- in v1", () => {
    expect(() => parseArgv(["node", "enclave", "--config", "x", "--", "pi"]))
      .toThrowError(UsageError);
  });

  it("UsageError carries the expected usage line", () => {
    try {
      parseArgv(["node", "enclave"]);
      throw new Error("expected UsageError");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toContain("enclave -- <program>");
    }
  });
});
