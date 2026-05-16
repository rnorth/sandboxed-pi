import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "../src/config.js";

let tmp: string;

beforeEach(() => {
  tmp = resolve(tmpdir(), `enclave-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeConfig(yaml: string): string {
  const path = resolve(tmp, "config.yaml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

describe("loadConfig", () => {
  it("parses a minimal valid config", () => {
    const path = writeConfig(`image: ubuntu:24.04\n`);
    const cfg = loadConfig(path);
    expect(cfg.image).toBe("ubuntu:24.04");
    expect(cfg.networkPolicies).toBeUndefined();
  });

  it("parses a config with networkPolicies", () => {
    const path = writeConfig(`
image: ubuntu:24.04
networkPolicies:
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
`);
    const cfg = loadConfig(path);
    expect(cfg.networkPolicies).toHaveLength(1);
    expect(cfg.networkPolicies?.[0].host).toBe("api.github.com");
    expect(cfg.networkPolicies?.[0].policies[0].action).toBe("ALLOW");
  });

  it("throws ConfigError with code 'missing' when the file does not exist", () => {
    const path = resolve(tmp, "does-not-exist.yaml");
    try {
      loadConfig(path);
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("missing");
      expect((err as ConfigError).message).toContain(path);
    }
  });

  it("throws ConfigError with code 'invalid' for missing image key", () => {
    const path = writeConfig(`networkPolicies: []\n`);
    try {
      loadConfig(path);
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("invalid");
      expect((err as ConfigError).message).toMatch(/image/i);
    }
  });

  it("throws ConfigError with code 'invalid' for malformed YAML", () => {
    const path = writeConfig(`image: ubuntu:24.04\n  bad indent: oops\n`);
    try {
      loadConfig(path);
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("invalid");
    }
  });

  it("throws ConfigError with code 'invalid' when policies.action is not ALLOW/DENY", () => {
    const path = writeConfig(`
image: ubuntu:24.04
networkPolicies:
  - host: api.github.com
    policies:
      - action: WHATEVER
        path: /.*
        method: GET
`);
    try {
      loadConfig(path);
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("invalid");
    }
  });

  it("defaultDenyActive() returns true when networkPolicies is missing or empty", () => {
    const a = loadConfig(writeConfig(`image: ubuntu:24.04\n`));
    const b = loadConfig(writeConfig(`image: ubuntu:24.04\nnetworkPolicies: []\n`));
    expect(a.defaultDenyActive()).toBe(true);
    expect(b.defaultDenyActive()).toBe(true);
  });

  it("defaultDenyActive() returns false when networkPolicies has entries", () => {
    const cfg = loadConfig(writeConfig(`
image: ubuntu:24.04
networkPolicies:
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /.*
        method: GET
`));
    expect(cfg.defaultDenyActive()).toBe(false);
  });
});
