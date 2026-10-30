// One end-to-end Apply scenario: stage files, wait for staging to settle, optionally tweak options,
// click Apply, and classify the outcome.
import path from "node:path";
import { errorNotices, newSession, runApply, snapshot, stage, waitApplyEnabled, waitSettled } from "./ui.mjs";
void waitApplyEnabled;
import { sha256 } from "../../fixtures/apply-matrix/encoders.mjs";

export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.skipReason = reason;
  }
}
export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const shortHash = (bytes) => (bytes ? sha256(bytes).slice(0, 12) : "-");

/**
 * Outcome classes:
 *  download  - app produced a file (bytes, name)
 *  blocked   - staging finished but Apply is disabled (a failed check / unsupported input)
 *  error     - clicking Apply surfaced an error notice
 *  timeout   - nothing happened within the limit
 */
export async function scenario(
  h,
  { files, configure, route, applyTimeout = 120_000, settleTimeout = 60_000, shot } = {},
) {
  const session = await newSession(h.browser, h.baseUrl, { route });
  const { page } = session;
  const out = { session };
  try {
    await stage(page, files);
    try {
      await waitSettled(page, settleTimeout);
      out.settled = true;
    } catch {
      out.settled = false;
    }
    await page.waitForTimeout(800); // let the Apply gate (blocked reason / enabled state) settle after the last verdict
    if (configure) await configure(page, session);
    out.staged = await snapshot(page);
    if (shot) await page.screenshot({ fullPage: true, path: path.join(h.caseDir, `${shot}-staged.png`) });
    if (out.staged.applyDisabled !== false) {
      out.outcome = "blocked";
      return out;
    }
    if (errorNotices(out.staged).length) {
      // Staging reported an error yet the Apply button is enabled: record it, do not trust a click.
      out.outcome = "staging-error";
      out.applyEnabledDespiteError = true;
      out.result = { kind: "staging-error", text: errorNotices(out.staged)[0].text };
      return out;
    }
    const result = await runApply(page, h.caseDir, { timeout: applyTimeout });
    out.result = result;
    out.outcome = result.kind;
    if (result.kind === "download") {
      out.bytes = result.bytes;
      out.name = result.name;
    }
    out.after = await snapshot(page);
    if (shot) await page.screenshot({ fullPage: true, path: path.join(h.caseDir, `${shot}-after.png`) });
    return out;
  } finally {
    out.pageErrors = session.pageErrors;
    out.consoleErrors = session.consoleErrors;
    await session.context.close();
  }
}

export const fail = (out, message) => {
  const state = out.after || out.staged;
  const where = state
    ? ` cards=${JSON.stringify(state.cards.map((card) => card.classes.filter((c) => ["ok", "bad", "warn"].includes(c)).join("/")))} notices=${JSON.stringify(state.notices.map((n) => n.text).slice(0, 2))} blocked=${JSON.stringify(state.blockedReason)}`
    : "";
  throw new Error(
    `${message} [outcome=${out.outcome}${out.result?.text ? ` text=${JSON.stringify(out.result.text)}` : ""}]${where}`,
  );
};

export const expectDownload = (out, expected, label = "output") => {
  if (out.pageErrors?.length) fail(out, `page error: ${out.pageErrors[0]}`);
  if (out.outcome !== "download") fail(out, `expected a download, got ${out.outcome}`);
  if (sha256(out.bytes) !== sha256(expected))
    fail(
      out,
      `${label} bytes differ: got ${out.bytes.length} B sha ${shortHash(out.bytes)}, want ${expected.length} B sha ${shortHash(expected)}`,
    );
};

/** Open a fresh Apply page and hand it to `fn`; always closes the context. */
export async function drive(h, fn, { route, ready } = {}) {
  const session = await newSession(h.browser, h.baseUrl, { ready, route });
  try {
    return await fn(session.page, session);
  } finally {
    await session.context.close();
  }
}

/** Stage files and wait for the form to settle; returns the settled flag. */
export async function stageAndSettle(page, files, settleTimeout = 60_000) {
  await stage(page, files);
  let settled = true;
  try {
    await waitSettled(page, settleTimeout);
  } catch {
    settled = false;
  }
  await page.waitForTimeout(800);
  return settled;
}

/** Wait for the primary button, click it and classify the outcome like scenario() does. */
export async function applyNow(h, page, { timeout = 120_000 } = {}) {
  const state = await snapshot(page);
  if (state.applyDisabled !== false) return { outcome: "blocked", staged: state };
  if (errorNotices(state).length)
    return {
      applyEnabledDespiteError: true,
      outcome: "staging-error",
      result: { kind: "staging-error", text: errorNotices(state)[0].text },
      staged: state,
    };
  const result = await runApply(page, h.caseDir, { timeout });
  return { ...result, outcome: result.kind, staged: state };
}

/**
 * Answer the candidate picker the app opens for a multi-member archive. `names` are the member names
 * to choose (several for the patch picker). Returns false when no picker appeared.
 */
export async function choose(page, names, { timeout = 15_000 } = {}) {
  const dialog = page.locator(".rw-modal[role=dialog]").first();
  try {
    await dialog.waitFor({ state: "visible", timeout });
  } catch {
    return false;
  }
  for (const name of names) await dialog.getByText(name, { exact: true }).first().click();
  const confirm = dialog.locator(".selconfirm");
  if (await confirm.count()) await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return true;
}
