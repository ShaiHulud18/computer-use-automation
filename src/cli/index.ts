/**
 * CLI — the composition root that wires every module together.
 *
 * Commands:
 *   discover      LLM-driven discovery run -> writes a capability artifact
 *   replay        deterministic, model-free execution of an artifact
 *   capabilities  the agent-facing catalog of recorded capabilities
 *   faults        arm/clear fault injection on the target app (demo harness)
 *
 * Design decisions:
 *  - COMPOSITION LIVES HERE, NOWHERE ELSE: the surface, broker, policy and
 *    logger are constructed in this file and handed to the discovery loop /
 *    replay executor as dependencies. The modules never construct each other,
 *    which is what keeps them independently testable against fakes.
 *  - EXIT CODES ARE THE MACHINE CONTRACT of the CLI: 0 = success OR a declared
 *    business outcome (an enumerated answer like MEMBER_NOT_FOUND is a result,
 *    not an error), 2 = hard failure, 3 = ended in human intervention,
 *    4 = discovery gave up / was aborted, 1 = CLI-level error (bad arguments,
 *    unreadable files, unreachable app).
 *  - process.exitCode, NEVER process.exit(): the run logger holds an open
 *    write stream and the surface/broker own real OS resources; setting
 *    exitCode lets pending writes and closes complete before node exits.
 *  - Paths that belong to the REPO (default policy, capabilities catalog,
 *    runs dir) are anchored via import.meta.url so the CLI behaves the same
 *    from any cwd; paths the USER types (--artifact, --policy) resolve
 *    against their cwd, as they would expect from any unix tool.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  OutputSpecSchema,
  ParamSpecSchema,
  parseArtifact,
  type CapabilityArtifact,
  type OutputSpec,
  type ParamSpec,
} from "../schema/artifact.js";
import type { ReplayResult } from "../schema/result.js";
import { PolicySchema, type Policy } from "../safety/policy.js";
import { WebSurface } from "../surface/web.js";
import { runDiscovery, type DiscoveryOutcome } from "../agent/loop.js";
import { replay } from "../replay/executor.js";
import { OperatorBroker } from "../hitl/broker.js";
import { createRunLogger, newRunId } from "../util/log.js";

/* ------------------------------------------------------------------ */
/* Repo-anchored paths (cwd-independent, same convention as agent/loop) */
/* ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, "config", "policy.json");
const CAPABILITIES_DIR = path.join(REPO_ROOT, "capabilities");
const RUNS_DIR = path.join(REPO_ROOT, "runs");

const VALID_FAULTS = ["interstitial", "slow", "session_expired", "error500"] as const;

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                 */
/* ------------------------------------------------------------------ */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Split "name=value" on the FIRST '=' so values may themselves contain '='. */
function splitPair(raw: string, flag: string): [string, string] {
  const i = raw.indexOf("=");
  if (i <= 0) {
    throw new Error(`${flag} expects name=value, got "${raw}"`);
  }
  return [raw.slice(0, i), raw.slice(i + 1)];
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return n;
}

function loadPolicy(policyPath: string): Policy {
  const resolved = path.resolve(policyPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`cannot read policy file ${resolved}: ${errorMessage(err)}`);
  }
  const parsed = PolicySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid policy ${resolved}: ${issues}`);
  }
  return parsed.data;
}

/** name=value pairs -> record (used for replay inputs). */
function parseInputValues(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const [name, value] = splitPair(raw, "--input");
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* discover                                                             */
/* ------------------------------------------------------------------ */

interface DiscoverCliOpts {
  goal: string;
  capabilityId: string;
  name?: string;
  app: string;
  entrypoint: string;
  input?: string[];
  inputSpec?: string[];
  output?: string[];
  sensitiveOutput?: string[];
  headless?: boolean;
  maxSteps?: number;
  policy: string;
}

/**
 * Combine --input values with their (optional) --input-spec ParamSpecs.
 * Specs are validated through ParamSpecSchema so zod defaults (required,
 * sensitive) are applied exactly as the artifact schema defines them.
 */
function buildDiscoveryInputs(
  valuePairs: string[],
  specPairs: string[],
): Record<string, { value: string; spec: ParamSpec }> {
  const values = new Map<string, string>();
  for (const raw of valuePairs) {
    const [name, value] = splitPair(raw, "--input");
    values.set(name, value);
  }
  const specs = new Map<string, ParamSpec>();
  for (const raw of specPairs) {
    const [name, json] = splitPair(raw, "--input-spec");
    if (!values.has(name)) {
      throw new Error(
        `--input-spec given for "${name}" but no matching --input ${name}=<value> was provided`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`--input-spec ${name}: invalid JSON — ${errorMessage(err)}`);
    }
    const res = ParamSpecSchema.safeParse(parsed);
    if (!res.success) {
      const issues = res.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`--input-spec ${name}: ${issues}`);
    }
    specs.set(name, res.data);
  }
  const out: Record<string, { value: string; spec: ParamSpec }> = {};
  for (const [name, value] of values) {
    out[name] = {
      value,
      // Default spec: a required string described by its own name — enough
      // for the compiler to parameterize the flow and the catalog to render.
      spec: specs.get(name) ?? ParamSpecSchema.parse({ type: "string", description: name }),
    };
  }
  return out;
}

function buildDiscoveryOutputs(
  pairs: string[],
  sensitiveNames: string[],
): Record<string, OutputSpec> {
  const out: Record<string, OutputSpec> = {};
  for (const raw of pairs) {
    const [name, description] = splitPair(raw, "--output");
    out[name] = OutputSpecSchema.parse({ type: "string", description });
  }
  for (const name of sensitiveNames) {
    const spec = out[name];
    if (!spec) {
      throw new Error(`--sensitive-output "${name}" does not match any declared --output`);
    }
    spec.sensitive = true;
  }
  return out;
}

function printDiscoverySummary(outcome: DiscoveryOutcome, evidenceDir: string): void {
  const lines: string[] = [
    "",
    "── discovery summary ─────────────────────────────",
    `status:        ${outcome.status}`,
    `steps taken:   ${outcome.stepsTaken}`,
  ];
  if (outcome.artifactPath) lines.push(`artifact:      ${outcome.artifactPath}`);
  const outputs = Object.entries(outcome.outputs ?? {});
  if (outputs.length > 0) {
    // Raw values on purpose: the invoker of a capability is entitled to its
    // outputs. Logs and evidence stay redacted at their own write boundary.
    lines.push("outputs:       (raw values — logs/evidence remain redacted)");
    for (const [k, v] of outputs) lines.push(`  ${k} = ${JSON.stringify(v)}`);
  }
  lines.push(`evidence dir:  ${evidenceDir}`);
  lines.push(`transcript:    ${outcome.transcriptPath}`);
  console.log(lines.join("\n"));
}

async function runDiscoverCommand(opts: DiscoverCliOpts): Promise<void> {
  const policy = loadPolicy(opts.policy);
  const inputs = buildDiscoveryInputs(opts.input ?? [], opts.inputSpec ?? []);
  const outputs = buildDiscoveryOutputs(opts.output ?? [], opts.sensitiveOutput ?? []);
  const log = createRunLogger(policy, newRunId("discover"), RUNS_DIR);

  let surface: WebSurface | undefined;
  let broker: OperatorBroker | undefined;
  try {
    // Discovery defaults to a visible browser: watching the model drive the
    // app is the demo; --headless opts out for CI-style runs.
    surface = await WebSurface.launch({ evidenceDir: log.dir, headed: !opts.headless, log });
    broker = new OperatorBroker({ surface, log });

    const outcome = await runDiscovery(
      {
        goal: opts.goal,
        capabilityId: opts.capabilityId,
        capabilityName: opts.name ?? opts.goal,
        appId: opts.app,
        entrypoint: opts.entrypoint,
        inputs,
        outputs,
        maxSteps: opts.maxSteps,
      },
      { surface, policy, log, broker },
    );

    printDiscoverySummary(outcome, log.dir);
    process.exitCode = outcome.status === "success" ? 0 : 4;
  } finally {
    // Broker first (it may be holding the operator console / a pending raise
    // that references the surface), then the browser itself. Close errors are
    // reported but never mask the primary outcome.
    if (broker) {
      await broker.close().catch((err) => {
        console.error(`warning: broker close failed: ${errorMessage(err)}`);
      });
    }
    if (surface) {
      await surface.close().catch((err) => {
        console.error(`warning: surface close failed: ${errorMessage(err)}`);
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* replay                                                               */
/* ------------------------------------------------------------------ */

interface ReplayCliOpts {
  artifact: string;
  input?: string[];
  tenant?: string;
  headed?: boolean;
  confirmRisky?: boolean;
  escalateOnFailure?: boolean;
  allowDraft: boolean;
  requireApproved?: boolean;
  policy: string;
}

function loadArtifact(artifactPath: string): CapabilityArtifact {
  const resolved = path.resolve(artifactPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`cannot read artifact ${resolved}: ${errorMessage(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`artifact ${resolved} is not valid JSON: ${errorMessage(err)}`);
  }
  return parseArtifact(json);
}

function printReplayResult(result: ReplayResult): void {
  console.log("");
  if (result.status === "business_outcome" && result.outcome) {
    // A declared outcome is a first-class answer — surface it before the
    // JSON dump so a human skimming the terminal cannot miss it.
    console.log("══════════════════════════════════════════════════");
    console.log(`BUSINESS OUTCOME: ${result.outcome.code}`);
    console.log(`  ${result.outcome.message}`);
    console.log("══════════════════════════════════════════════════");
  }
  if (result.outputs && Object.keys(result.outputs).length > 0) {
    console.log(
      "note: outputs below are raw values — the caller is entitled to them; logs and evidence remain redacted.",
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

const REPLAY_EXIT_CODES: Record<ReplayResult["status"], number> = {
  success: 0,
  business_outcome: 0, // a legitimate, enumerated answer — not an error
  hard_failure: 2,
  intervention: 3,
};

async function runReplayCommand(opts: ReplayCliOpts): Promise<void> {
  const artifact = loadArtifact(opts.artifact);
  const policy = loadPolicy(opts.policy);
  const inputs = parseInputValues(opts.input ?? []);
  const log = createRunLogger(policy, newRunId("replay"), RUNS_DIR);

  // Drafts run by default because a freshly discovered artifact IS a draft —
  // demanding approval before the first replay would dead-end the demo loop.
  // --require-approved turns the production gate on (and wins over the default).
  const allowDraft = opts.requireApproved ? false : opts.allowDraft;
  if (allowDraft && artifact.capability.status !== "approved") {
    console.log(
      'notice: artifact status is "draft" — running anyway (drafts allowed by default; pass --require-approved to enforce the approval gate).',
    );
  }

  let surface: WebSurface | undefined;
  let broker: OperatorBroker | undefined;
  try {
    surface = await WebSurface.launch({ evidenceDir: log.dir, headed: !!opts.headed, log });
    broker = new OperatorBroker({ surface, log });

    const result = await replay({
      artifact,
      inputs,
      tenant: opts.tenant,
      policy,
      surface,
      log,
      broker,
      confirmRisky: !!opts.confirmRisky,
      escalateOnFailure: !!opts.escalateOnFailure,
      allowDraft,
    });

    printReplayResult(result);
    // Persist the structured result alongside the run's log as evidence.
    // Unlike stdout (the caller is entitled to raw outputs), the persisted
    // copy masks outputs the contract marks sensitive.
    const persisted = {
      ...result,
      outputs:
        result.outputs &&
        Object.fromEntries(
          Object.entries(result.outputs).map(([k, v]) => [
            k,
            artifact.contract.outputs[k]?.sensitive ? "▓▓REDACTED▓▓" : v,
          ]),
        ),
    };
    fs.writeFileSync(path.join(log.dir, "result.json"), JSON.stringify(persisted, null, 2) + "\n", "utf8");
    process.exitCode = REPLAY_EXIT_CODES[result.status];
  } finally {
    if (broker) {
      await broker.close().catch((err) => {
        console.error(`warning: broker close failed: ${errorMessage(err)}`);
      });
    }
    if (surface) {
      await surface.close().catch((err) => {
        console.error(`warning: surface close failed: ${errorMessage(err)}`);
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* capabilities                                                         */
/* ------------------------------------------------------------------ */

interface CatalogEntry {
  file: string;
  id: string;
  version: number;
  status: string;
  name: string;
  description: string;
  inputs: CapabilityArtifact["contract"]["inputs"];
  outputs: CapabilityArtifact["contract"]["outputs"];
  outcomes: CapabilityArtifact["contract"]["outcomes"];
}

function readCatalog(): { entries: CatalogEntry[]; warnings: string[] } {
  const entries: CatalogEntry[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(CAPABILITIES_DIR)) return { entries, warnings };
  for (const file of fs.readdirSync(CAPABILITIES_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(CAPABILITIES_DIR, file);
    try {
      const artifact = parseArtifact(JSON.parse(fs.readFileSync(full, "utf8")));
      entries.push({
        file: full,
        id: artifact.capability.id,
        version: artifact.capability.version,
        status: artifact.capability.status,
        name: artifact.capability.name,
        description: artifact.capability.description,
        inputs: artifact.contract.inputs,
        outputs: artifact.contract.outputs,
        outcomes: artifact.contract.outcomes,
      });
    } catch (err) {
      // A malformed file must not hide the rest of the catalog; report it
      // on stderr so --json consumers still get clean JSON on stdout.
      warnings.push(`skipped ${file}: ${errorMessage(err).split("\n")[0] ?? "invalid"}`);
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  return { entries, warnings };
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "─".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

function runCapabilitiesCommand(opts: { json?: boolean }): void {
  const { entries, warnings } = readCatalog();
  for (const w of warnings) console.error(`warning: ${w}`);

  if (opts.json) {
    // Machine face of the catalog: the full contract, so a calling agent can
    // select a capability and construct a valid invocation from this alone.
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log(`no capabilities recorded yet (looked in ${CAPABILITIES_DIR})`);
    console.log('run a discovery first: npm run discover -- --goal "..." --capability-id <slug>');
    return;
  }

  const rows = entries.map((e) => [
    e.id,
    `v${e.version}`,
    e.status,
    e.name,
    Object.entries(e.inputs)
      .map(([n, s]) => `${n}${s.required ? "" : "?"}:${s.type}`)
      .join(", "),
    Object.entries(e.outputs)
      .map(([n, s]) => `${n}:${s.type}${s.sensitive ? " (sensitive)" : ""}`)
      .join(", "),
    e.outcomes.map((o) => o.code).join(", "),
  ]);
  console.log(renderTable(["ID", "VER", "STATUS", "NAME", "INPUTS", "OUTPUTS", "OUTCOMES"], rows));
}

/* ------------------------------------------------------------------ */
/* faults                                                               */
/* ------------------------------------------------------------------ */

interface FaultsCliOpts {
  set?: string;
  clear?: boolean;
  times: number;
  target: string;
}

async function faultsFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(
      `could not reach the target app at ${url} — is it running? (npm run target-app) [${errorMessage(err)}]`,
    );
  }
}

async function runFaultsCommand(opts: FaultsCliOpts): Promise<void> {
  const base = opts.target.replace(/\/+$/, "");
  const endpoint = `${base}/__faults`;

  if (opts.set && opts.clear) {
    throw new Error("--set and --clear are mutually exclusive");
  }

  if (opts.set) {
    if (!(VALID_FAULTS as readonly string[]).includes(opts.set)) {
      throw new Error(`unknown fault "${opts.set}" — expected one of: ${VALID_FAULTS.join(", ")}`);
    }
    const res = await faultsFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fault: opts.set, times: opts.times }),
    });
    if (!res.ok) throw new Error(`fault API returned HTTP ${res.status} arming "${opts.set}"`);
    console.log(`armed fault "${opts.set}" for the next ${opts.times} page request(s)`);
  } else if (opts.clear) {
    const res = await faultsFetch(endpoint, { method: "DELETE" });
    if (!res.ok) throw new Error(`fault API returned HTTP ${res.status} clearing faults`);
    console.log("cleared all armed faults (and any expired sessions)");
  }

  // Always finish by showing the authoritative state from the app itself.
  const state = await faultsFetch(endpoint).then((r) => r.json());
  console.log(JSON.stringify(state, null, 2));
}

/* ------------------------------------------------------------------ */
/* Program wiring                                                       */
/* ------------------------------------------------------------------ */

const program = new Command();

program
  .name("capability-automation")
  .description(
    "LLM computer-use automation: discover UI flows into typed capability artifacts, replay them deterministically, escalate to humans when needed.",
  );

program
  .command("discover")
  .description("run an LLM discovery session and compile a capability artifact")
  .requiredOption("--goal <text>", "natural-language goal for the discovery agent")
  .requiredOption("--capability-id <slug>", 'stable capability id, e.g. "lookup-member-balance"')
  .option("--name <text>", "human-readable capability name (default: the goal)")
  .option("--app <appId>", "app profile id (config/apps/<appId>.json)", "legacy-cu-core")
  .option("--entrypoint <url>", "URL the flow starts from", "http://localhost:4173/")
  .option("--input <name=value...>", "concrete input value(s) for this run (repeatable)")
  .option(
    "--input-spec <name=json...>",
    'ParamSpec JSON per input, e.g. mid=\'{"type":"string","description":"Member ID","pattern":"^\\\\d{5}$"}\' (default: required string)',
  )
  .option("--output <name=description...>", "declared output(s) the flow must extract (repeatable)")
  .option("--sensitive-output <name...>", "mark declared output(s) sensitive (masked in logs)")
  .option("--headed", "run with a visible browser (already the default for discovery)")
  .option("--headless", "run without a visible browser (overrides the headed default)")
  .option("--max-steps <n>", "discovery step budget", parsePositiveInt)
  .option("--policy <path>", "safety policy file", DEFAULT_POLICY_PATH)
  .action(async (opts: DiscoverCliOpts) => {
    await runDiscoverCommand(opts);
  });

program
  .command("replay")
  .description("execute a capability artifact deterministically (no model in the loop)")
  .requiredOption("--artifact <path>", "path to a capability artifact JSON")
  .option("--input <name=value...>", "input value(s) for this invocation (repeatable)")
  .option("--tenant <id>", "apply the artifact's tenantOverrides for this tenant")
  .option("--headed", "run with a visible browser (replay defaults to headless)")
  .option("--confirm-risky", 'pre-approve risky steps (when policy handling is "confirm")')
  .option("--escalate-on-failure", "offer the live session to a human on unexplained failures")
  .option("--allow-draft", "run non-approved (draft) artifacts", true)
  .option("--require-approved", "enforce the approval gate (overrides --allow-draft)")
  .option("--policy <path>", "safety policy file", DEFAULT_POLICY_PATH)
  .action(async (opts: ReplayCliOpts) => {
    await runReplayCommand(opts);
  });

program
  .command("capabilities")
  .description("list the recorded capability catalog (the agent-facing API surface)")
  .option("--json", "emit the catalog as JSON for machine consumption")
  .action((opts: { json?: boolean }) => {
    runCapabilitiesCommand(opts);
  });

program
  .command("faults")
  .description("arm or clear fault injection on the target app; always prints current state")
  .option("--set <fault>", `arm a fault: ${VALID_FAULTS.join(" | ")}`)
  .option("--clear", "clear all armed faults")
  .option("--times <n>", "how many page requests the fault applies to", parsePositiveInt, 1)
  .option("--target <url>", "target app base URL", "http://localhost:4173")
  .action(async (opts: FaultsCliOpts) => {
    await runFaultsCommand(opts);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`error: ${errorMessage(err)}`);
  process.exitCode = 1;
});
