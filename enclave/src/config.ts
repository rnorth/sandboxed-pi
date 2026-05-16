/**
 * Loads and validates ~/.config/enclave/config.yaml.
 *
 * On success: returns a typed Config object with helpers.
 * On failure: throws ConfigError with a `code` discriminator the CLI
 * uses to choose an exit code and a user-facing message.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const RuleSchema = z.object({
  action: z.enum(["ALLOW", "DENY"]),
  path: z.string(),
  method: z.string(),
});

const NetworkPolicySchema = z.object({
  host: z.string().min(1),
  policies: z.array(RuleSchema),
});

const ConfigSchema = z.object({
  image: z.string().min(1, "image is required"),
  networkPolicies: z.array(NetworkPolicySchema).optional(),
});

export type Rule = z.infer<typeof RuleSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type RawConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly code: "missing" | "invalid", message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config extends RawConfig {
  /**
   * True when the proxy should be started in default-deny mode (no
   * explicit allow rules in the config). Triggers a startup warning.
   */
  defaultDenyActive(): boolean;
}

const EXAMPLE_CONFIG = `image: ghcr.io/catthehacker/ubuntu:act-latest

# Optional. If omitted or empty, all outbound HTTP/HTTPS is blocked.
networkPolicies:
  - host: api.github.com
    policies:
      - action: ALLOW
        path: /repos/.*
        method: GET
`;

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      "missing",
      `No config at ${path}\n\nCreate one with the following minimal contents:\n\n${EXAMPLE_CONFIG}`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf-8"));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ConfigError("invalid", `${path}: malformed YAML: ${cause}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      "invalid",
      `${path}: configuration failed validation:\n${detail}`,
    );
  }

  const data = result.data;
  return {
    ...data,
    defaultDenyActive: () => !data.networkPolicies || data.networkPolicies.length === 0,
  };
}
