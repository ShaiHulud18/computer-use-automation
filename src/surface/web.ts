/**
 * WebSurface — the Playwright implementation of the Surface seam.
 *
 * Design notes:
 *  - PERCEPTION IS AN INVENTORY: observe() runs one self-contained script in
 *    the page and returns a numbered element inventory. Refs ("e1".."eN") are
 *    ephemeral by contract; internally each ref maps to a structural CSS path
 *    so actOnRef() can address the element without re-scanning.
 *  - TWO ACTION PATHS, ONE SURFACE: actOnRef() serves discovery (LLM picks a
 *    ref from the last observation); act() serves replay (targets resolved via
 *    the artifact's locator ladder). Both funnel into the same Playwright
 *    session, which is what makes human handoff on the live session possible.
 *  - NO WAITING HERE: the executor owns settle/wait-until policy, because
 *    timing tolerances belong to the artifact, not the driver. Methods return
 *    as soon as Playwright's own action semantics complete.
 *  - MAIN FRAME TODAY, FRAME LOOP TOMORROW: the mock app is frameless, but
 *    observe() is structured as a loop over frames so legacy frameset support
 *    is an additive change (see observe()).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { Condition, LocatorCandidate, StepAction, TargetSpec } from "../schema/artifact.js";
import type {
  DiscoveryAction,
  EvidenceSnapshot,
  HumanAction,
  Observation,
  ObservedElement,
  Surface,
} from "./types.js";
import type { RunLogger } from "../util/log.js";

export interface WebSurfaceOptions {
  headed?: boolean;
  evidenceDir: string;
  log: RunLogger;
  slowMoMs?: number;
}

/**
 * Thrown by act() when no rung of a target's locator ladder resolves.
 * Carries the full list of attempted candidates so failure reports can show
 * exactly which locators drifted (that is the input to re-discovery).
 */
export class TargetResolutionError extends Error {
  readonly targetDescription: string;
  readonly tried: string[];

  constructor(targetDescription: string, tried: string[]) {
    super(
      `could not resolve target "${targetDescription}" — tried ${tried.length} candidate(s): ${tried.join(" | ")}`,
    );
    this.name = "TargetResolutionError";
    this.targetDescription = targetDescription;
    this.tried = tried;
  }
}

/* ------------------------------------------------------------------ */
/* In-page observation script                                          */
/* ------------------------------------------------------------------ */

/** Shape returned by the in-page collector (ObservedElement minus ref/frame). */
interface RawElement {
  role: string;
  name: string;
  value?: string;
  labelText?: string;
  placeholder?: string;
  visibleText?: string;
  cssPath: string;
  box: { x: number; y: number; width: number; height: number };
}

interface PageScan {
  title: string;
  visibleText: string;
  elements: RawElement[];
}

/**
 * Runs INSIDE the page via frame.evaluate(). Must be fully self-contained:
 * Playwright serializes only this function's source, so every helper lives
 * inside the closure and nothing references module scope.
 */
const collectPageState = (): PageScan => {
  // Guard for documents created before the context init script ran
  // (e.g. the initial about:blank): see the __name note in launch().
  (globalThis as { __name?: unknown }).__name ??= (f: unknown) => f;
  const cap = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

  /** Text of the element's own text nodes only (excludes child elements),
   *  so a td that merely wraps a "View Record" link is not a balance cell. */
  const directText = (el: Element): string => {
    let s = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) s += n.textContent ?? "";
    }
    return s;
  };

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    // offsetParent is null for display:none subtrees; position:fixed also
    // reports null, so exempt fixed elements rather than dropping them.
    const he = el as HTMLElement;
    if (he.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    return true;
  };

  /**
   * Structural CSS path: tag + nth-of-type at every level, no classes and no
   * ids. Classes are meaningless in legacy apps (or utility soup); ids are
   * frequently generated per-session by legacy frameworks, so a purely
   * structural path is the most deterministic last-resort address we can
   * hand back. Unique by construction: each hop pins the exact same-tag
   * sibling index.
   */
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === "html") {
        parts.unshift("html");
        break;
      }
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  /** <label for=...> first, wrapping <label> second — the two ways the
   *  pinned app (and most legacy HTML) associates labels. */
  const labelTextFor = (el: Element): string | undefined => {
    if (el.id) {
      const t = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
      if (t) return cap(t, 80);
    }
    const wrapped = el.closest("label")?.textContent?.trim();
    if (wrapped) return cap(wrapped, 80);
    return undefined;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "td") return "cell";
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox"; // text | number | password | search | ...
    }
    return tag;
  };

  /** Accessible-name precedence: aria-label, associated label, value for
   *  submit-style inputs, then trimmed innerText. Mirrors (a useful subset
   *  of) the accname algorithm without pulling in a full implementation. */
  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) return cap(aria, 80);
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const lbl = labelTextFor(el);
      if (lbl) return lbl;
      if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") && el.value) {
        return cap(el.value, 80);
      }
    }
    return cap((el as HTMLElement).innerText ?? "", 80);
  };

  const nodes = Array.from(
    document.querySelectorAll("a[href], button, input, select, textarea, [role=button], td"),
  );
  const out: RawElement[] = [];
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    // Data cells are first-class extraction targets: legacy apps render the
    // facts we need (names, statuses, balances) as bare table cells. Include
    // LEAF cells only (no nested tables/cells — those are layout scaffolding,
    // not data) with short text; interactive content is reachable via its
    // own controls, so cells containing controls are skipped too.
    if (tag === "td") {
      const text = cap((el as HTMLElement).innerText ?? "", 200);
      const isLeaf = !el.querySelector("table, td, a, button, input, select");
      if (!isLeaf || text.length === 0 || text.length > 80) continue;
    }
    if (!isVisible(el)) continue;

    let value: string | undefined;
    if (el instanceof HTMLInputElement) {
      // Never surface password contents to the model or the logs.
      value = el.type === "password" ? "[password hidden]" : el.value;
    } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      value = el.value;
    }

    const isFormControl =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement;

    const rect = el.getBoundingClientRect();
    const visibleText = cap((el as HTMLElement).innerText ?? "", 120);
    out.push({
      role: roleOf(el),
      name: accessibleName(el),
      value,
      labelText: isFormControl ? labelTextFor(el) : undefined,
      placeholder: el.getAttribute("placeholder") ?? undefined,
      visibleText: visibleText || undefined,
      cssPath: cssPath(el),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  return {
    title: document.title,
    visibleText: (document.body?.innerText ?? "").slice(0, 6000),
    elements: out,
  };
};

/** Human-readable form of a locator candidate, used in logs and errors. */
function describeCandidate(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return `role=${c.role} name="${c.name}"`;
    case "label":
      return `label="${c.text}"`;
    case "text":
      return `text="${c.text}"${c.exact ? "" : " (substring)"}`;
    case "placeholder":
      return `placeholder="${c.text}"`;
    case "css":
      return `css=${c.selector}`;
  }
}

/* ------------------------------------------------------------------ */
/* The surface                                                         */
/* ------------------------------------------------------------------ */

export class WebSurface implements Surface {
  readonly kind = "web" as const;
  /** Escape hatch for the HITL broker: the human operates THIS page. */
  readonly page: Page;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly log: RunLogger;
  private readonly evidenceDir: string;

  /** ref -> structural CSS path, valid only for the most recent observe().
   *  If frames are ever added, this becomes ref -> {framePath, cssPath}. */
  private readonly lastObsRefs = new Map<string, string>();
  private obsSeq = 0;

  private recording = false;
  private humanActions: HumanAction[] = [];
  private recordingHooksInstalled = false;

  private constructor(browser: Browser, context: BrowserContext, page: Page, opts: WebSurfaceOptions) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.log = opts.log;
    this.evidenceDir = opts.evidenceDir;
    fs.mkdirSync(this.evidenceDir, { recursive: true });
  }

  static async launch(opts: WebSurfaceOptions): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMoMs });
    const context = await browser.newContext();
    // tsx runs through esbuild with keepNames, which decorates every function
    // with a `__name(...)` helper call. Playwright serializes evaluate()
    // callbacks by source, so the helper must exist inside the page or every
    // in-page script dies with "ReferenceError: __name is not defined".
    await context.addInitScript("globalThis.__name = globalThis.__name ?? ((f) => f);");
    const page = await context.newPage();
    const surface = new WebSurface(browser, context, page, opts);
    await surface.installHumanRecordingHooks();
    opts.log.event("surface.launch", { kind: "web", headed: String(!!opts.headed) });
    return surface;
  }

  /* ---------------------------- perception --------------------------- */

  async observe(opts?: { screenshot?: boolean }): Promise<Observation> {
    this.obsSeq += 1;

    // Main-frame scan only. Legacy frameset/iframe support slots in here:
    // walk page.frames() (or childFrames() recursively to build name chains),
    // push one entry per frame with its framePath, and the loop below does
    // the rest — refs stay globally sequential across frames.
    const frames: Array<{ frame: Frame; framePath: string[] }> = [
      { frame: this.page.mainFrame(), framePath: [] },
    ];

    this.lastObsRefs.clear();
    const elements: ObservedElement[] = [];
    let title = "";
    let visibleText = "";

    for (const { frame, framePath } of frames) {
      const scan = await frame.evaluate(collectPageState);
      if (framePath.length === 0) {
        title = scan.title;
        visibleText = scan.visibleText;
      }
      for (const raw of scan.elements) {
        const ref = `e${elements.length + 1}`;
        this.lastObsRefs.set(ref, raw.cssPath);
        elements.push({
          ref,
          role: raw.role,
          name: raw.name,
          value: raw.value,
          descriptors: {
            labelText: raw.labelText,
            placeholder: raw.placeholder,
            visibleText: raw.visibleText,
            framePath,
            cssPath: raw.cssPath,
          },
          boundingBox: raw.box,
        });
      }
    }

    let screenshotPath: string | undefined;
    if (opts?.screenshot !== false) {
      screenshotPath = path.join(this.evidenceDir, `obs-${this.obsSeq}.png`);
      await this.page.screenshot({ path: screenshotPath });
    }

    const url = this.page.url();
    this.log.event("surface.observe", {
      url,
      title,
      elements: elements.length,
      screenshot: screenshotPath ?? "none",
    });
    return { url, title, elements, visibleText, screenshotPath };
  }

  /* --------------------------- discovery path ------------------------ */

  async actOnRef(action: DiscoveryAction): Promise<void> {
    this.log.event("surface.actOnRef", {
      type: action.type,
      ...(action.type === "navigate" ? { url: action.url } : { ref: action.ref }),
      // Values are logged as length only: the surface cannot know which
      // params are sensitive — that judgment lives with the caller/policy.
      ...(action.type === "fill" ? { valueLen: action.value.length } : {}),
    });

    if (action.type === "navigate") {
      await this.page.goto(action.url);
      return;
    }

    const loc = this.locatorForRef(action.ref);
    switch (action.type) {
      case "click":
        await loc.click();
        break;
      case "fill":
        await loc.fill(action.value);
        break;
      case "select":
        await this.selectByLabelOrValue(loc, action.value);
        break;
      case "press":
        await loc.press(action.key);
        break;
      case "extract":
        // Deliberate no-op: the discovery loop reads via readTextByRef().
        // Keeping "extract" an accepted action type keeps the policy and
        // action plumbing uniform across discovery and replay.
        break;
    }
    // No waiting here — the caller owns settle/wait policy.
  }

  /** Extract support for the discovery loop's "extract" tool. */
  async readTextByRef(ref: string): Promise<string | null> {
    const loc = this.locatorForRef(ref);
    try {
      const text = (await loc.innerText({ timeout: 3_000 })).trim();
      this.log.event("surface.readTextByRef", { ref, chars: text.length });
      return text;
    } catch {
      this.log.event("surface.readTextByRef", { ref, chars: "unreadable" });
      return null;
    }
  }

  private locatorForRef(ref: string): Locator {
    const css = this.lastObsRefs.get(ref);
    if (!css) {
      throw new Error(
        `unknown or stale element ref "${ref}" — refs are only valid for the most recent observation; call observe() again`,
      );
    }
    return this.page.locator(css);
  }

  /* ---------------------------- replay path -------------------------- */

  async resolveTarget(target: TargetSpec): Promise<{ candidateIndex: number } | null> {
    for (let i = 0; i < target.candidates.length; i++) {
      const c = target.candidates[i];
      if (!c) continue;
      try {
        const loc = this.buildLocator(c);
        // A candidate wins only when it is UNAMBIGUOUS (exactly one match)
        // and visible — a ladder rung that matches two things is drift, not
        // a hit, and falling through to the next rung is the safer read.
        if ((await loc.count()) === 1 && (await loc.first().isVisible())) {
          this.log.event("surface.resolve", {
            target: target.description,
            won: describeCandidate(c),
            candidateIndex: i,
          });
          return { candidateIndex: i };
        }
      } catch {
        // Malformed selector / detached DOM mid-probe: try the next rung.
        // Probes must never throw out of resolveTarget — "nothing resolved"
        // is a result, not an exception.
      }
    }
    this.log.event("surface.resolve", {
      target: target.description,
      won: "none",
      candidatesTried: target.candidates.length,
    });
    return null;
  }

  async act(action: StepAction): Promise<void> {
    this.log.event("surface.act", {
      type: action.type,
      ...(action.type === "navigate"
        ? { url: action.url }
        : { target: action.target.description }),
    });

    if (action.type === "navigate") {
      await this.page.goto(action.url);
      return;
    }

    const resolved = await this.resolveTarget(action.target);
    if (!resolved) {
      throw new TargetResolutionError(
        action.target.description,
        action.target.candidates.map(describeCandidate),
      );
    }
    const winner = action.target.candidates[resolved.candidateIndex];
    if (!winner) {
      // Unreachable (resolveTarget returns in-range indexes); guards strict
      // index typing without a non-null assertion.
      throw new TargetResolutionError(action.target.description, []);
    }
    // .first() is a no-op on a count()===1 locator; kept so a race that adds
    // a duplicate between resolve and act degrades to "acted on the first"
    // instead of a strictness error mid-action.
    const loc = this.buildLocator(winner).first();

    switch (action.type) {
      case "click":
        await loc.click();
        break;
      case "fill":
        await loc.fill(action.value);
        break;
      case "select":
        await this.selectByLabelOrValue(loc, action.value);
        break;
      case "press":
        await loc.press(action.key);
        break;
      case "extract":
        // No side effect: the executor binds outputs via readText(). act()
        // on an extract step only proves the target still resolves.
        break;
    }
    // Deliberately no auto-wait: the executor owns waiting, so timing policy
    // lives in the artifact (wait.until/timeoutMs), not in the driver.
  }

  private buildLocator(c: LocatorCandidate): Locator {
    // Frame-scoping extension point: swap `root` for the frame addressed by
    // the target's framePath when frameset support lands.
    const root = this.page;
    switch (c.strategy) {
      case "role":
        // Artifact roles are open strings (surface-agnostic schema); narrow
        // to Playwright's role union at this boundary only.
        return root.getByRole(c.role as Parameters<Page["getByRole"]>[0], {
          name: c.name,
          exact: true,
        });
      case "label":
        return root.getByLabel(c.text, { exact: true });
      case "text":
        return root.getByText(c.text, { exact: c.exact });
      case "placeholder":
        return root.getByPlaceholder(c.text);
      case "css":
        return root.locator(c.selector);
    }
  }

  /**
   * Recorded select values are the human-visible option labels (that is what
   * the discovery model sees on screen), but some builds use distinct value
   * attributes. Read the option list once and match label first, value
   * second — deterministic, and avoids burning a full Playwright timeout
   * probing one interpretation before falling back to the other.
   */
  private async selectByLabelOrValue(loc: Locator, wanted: string): Promise<void> {
    const options = await loc.evaluate((el) =>
      el instanceof HTMLSelectElement
        ? Array.from(el.options).map((o) => ({ label: o.label.trim(), value: o.value }))
        : null,
    );
    if (!options) throw new Error(`select action targeted a non-<select> element`);
    const match =
      options.find((o) => o.label === wanted) ?? options.find((o) => o.value === wanted);
    if (!match) {
      throw new Error(
        `no option matching "${wanted}" — available: ${options.map((o) => o.label).join(", ")}`,
      );
    }
    await loc.selectOption(match.value);
  }

  /* ------------------------- conditions & reads ---------------------- */

  async check(condition: Condition): Promise<boolean> {
    const ok = await this.evalCondition(condition);
    this.log.event("surface.check", { kind: condition.kind, result: ok ? "pass" : "fail" });
    return ok;
  }

  private async evalCondition(condition: Condition): Promise<boolean> {
    switch (condition.kind) {
      case "url_matches":
        return new RegExp(condition.pattern).test(this.page.url());
      case "text_visible": {
        // innerText (not content()) so hidden markup can't fake visibility.
        const body = await this.page
          .evaluate(() => document.body?.innerText ?? "")
          .catch(() => ""); // mid-navigation: treat as "not visible", not an error
        return new RegExp(condition.pattern).test(body);
      }
      case "element_visible":
        return (await this.resolveTarget(condition.target)) !== null;
    }
  }

  async readText(target: TargetSpec): Promise<string | null> {
    const resolved = await this.resolveTarget(target);
    if (!resolved) {
      this.log.event("surface.readText", { target: target.description, result: "unresolved" });
      return null;
    }
    const winner = target.candidates[resolved.candidateIndex];
    if (!winner) return null; // unreachable; satisfies strict index typing
    try {
      const text = (await this.buildLocator(winner).first().innerText({ timeout: 5_000 })).trim();
      this.log.event("surface.readText", { target: target.description, chars: text.length });
      return text;
    } catch {
      this.log.event("surface.readText", { target: target.description, result: "unreadable" });
      return null;
    }
  }

  /* ------------------------- evidence & state ------------------------ */

  async captureEvidence(tag: string): Promise<EvidenceSnapshot> {
    // Tags come from our own code, but sanitize anyway: evidence filenames
    // must never be able to escape the run directory.
    const safeTag = tag.replace(/[^\w.-]+/g, "_");
    const screenshotPath = path.join(this.evidenceDir, `${safeTag}.png`);
    const structurePath = path.join(this.evidenceDir, `${safeTag}.html`);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.promises.writeFile(structurePath, await this.page.content(), "utf8");
    this.log.event("surface.evidence", { tag: safeTag, screenshotPath, structurePath });
    return { screenshotPath, structurePath };
  }

  async location(): Promise<string> {
    const url = this.page.url();
    this.log.event("surface.location", { url });
    return url;
  }

  async settle(timeoutMs = 5_000): Promise<void> {
    // "load" is the hard requirement; a page that never loads should fail
    // loudly so the executor's timeout/detector machinery can classify it.
    await this.page.waitForLoadState("load", { timeout: timeoutMs });
    try {
      // networkidle is best-effort polish: long-polling or a slow favicon
      // must not fail a step whose document already loaded.
      await this.page.waitForLoadState("networkidle", { timeout: Math.min(1_500, timeoutMs) });
    } catch {
      /* idle never reached within budget — acceptable */
    }
    this.log.event("surface.settle", { url: this.page.url() });
  }

  /* -------------------------- human recording ------------------------ */

  /**
   * Handoff auditing. Mechanics:
   *  - one context-level binding ("__reportHumanAction") carries events from
   *    the page to Node; installed exactly once at launch (exposeBinding
   *    throws on double registration, hence the guard);
   *  - an init script attaches capture-phase click/change listeners in every
   *    new document, gated on window.__recordingEnabled so listeners are
   *    inert outside a handoff;
   *  - navigations reset the page's JS realm, so a framenavigated hook both
   *    records the navigation and re-arms the flag while recording is on.
   * Typed values are NEVER captured — only that a named field changed.
   */
  private async installHumanRecordingHooks(): Promise<void> {
    if (this.recordingHooksInstalled) return;
    this.recordingHooksInstalled = true;

    await this.context.exposeBinding(
      "__reportHumanAction",
      (_source, action: { kind?: unknown; detail?: unknown }) => {
        if (!this.recording) return;
        this.humanActions.push({
          at: new Date().toISOString(),
          kind: String(action?.kind ?? "unknown"),
          detail: String(action?.detail ?? "").slice(0, 200),
        });
      },
    );

    await this.context.addInitScript(() => {
      type RecWindow = Window & {
        __recordingEnabled?: boolean;
        __reportHumanAction?: (a: { kind: string; detail: string }) => void;
      };
      const w = window as RecWindow;
      const report = (kind: string, detail: string): void => {
        try {
          w.__reportHumanAction?.({ kind, detail });
        } catch {
          /* binding unavailable (page torn down) — drop the event */
        }
      };

      document.addEventListener(
        "click",
        (ev) => {
          if (!w.__recordingEnabled) return;
          const raw = ev.target instanceof Element ? ev.target : null;
          if (!raw) return;
          // Describe the interactive control, not the text node inside it.
          const el = raw.closest("a, button, input, select, textarea, [role=button]") ?? raw;
          const name = (
            el.getAttribute("aria-label") ??
            (el as HTMLElement).innerText ??
            (el as HTMLInputElement).value ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          report("click", `${el.tagName.toLowerCase()} "${name}"`);
        },
        true, // capture phase: fires even if the app stops propagation
      );

      document.addEventListener(
        "change",
        (ev) => {
          if (!w.__recordingEnabled) return;
          const t = ev.target;
          if (
            !(t instanceof HTMLInputElement) &&
            !(t instanceof HTMLSelectElement) &&
            !(t instanceof HTMLTextAreaElement)
          ) {
            return;
          }
          // Identify the field by its label/name; the VALUE is never sent.
          let label = t.getAttribute("aria-label") ?? "";
          if (!label && t.id) {
            label = document.querySelector(`label[for="${CSS.escape(t.id)}"]`)?.textContent?.trim() ?? "";
          }
          if (!label) label = t.closest("label")?.textContent?.trim() ?? "";
          if (!label) label = t.getAttribute("name") ?? t.tagName.toLowerCase();
          const mask =
            t instanceof HTMLInputElement && t.type === "password"
              ? "[password hidden]"
              : "[value hidden]";
          report("fill", `field "${label.slice(0, 80)}" = ${mask}`);
        },
        true,
      );
    });

    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return;
      if (!this.recording) return;
      this.humanActions.push({
        at: new Date().toISOString(),
        kind: "navigate",
        detail: frame.url(),
      });
      // The fresh document's realm starts with the flag unset; re-arm it so
      // the init-script listeners keep reporting. Fire-and-forget: a page
      // torn down mid-evaluate is not an error worth failing a handoff for.
      void this.setRecordingFlag(true);
    });
  }

  async startHumanRecording(): Promise<void> {
    this.recording = true;
    await this.setRecordingFlag(true);
    this.log.event("surface.humanRecording", { state: "started" });
  }

  async stopHumanRecording(): Promise<HumanAction[]> {
    this.recording = false;
    await this.setRecordingFlag(false);
    const actions = this.humanActions.splice(0); // return accumulated + clear
    this.log.event("surface.humanRecording", { state: "stopped", actions: actions.length });
    return actions;
  }

  private async setRecordingFlag(on: boolean): Promise<void> {
    await this.page
      .evaluate((v) => {
        (window as Window & { __recordingEnabled?: boolean }).__recordingEnabled = v;
      }, on)
      .catch(() => {
        /* page navigating/closed — the init script re-arms on next document */
      });
  }

  /* ------------------------------ lifecycle -------------------------- */

  async close(): Promise<void> {
    this.log.event("surface.close", {});
    await this.browser.close();
  }
}
