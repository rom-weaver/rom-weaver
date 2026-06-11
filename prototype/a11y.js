/* ═══════════════════════════════════════════════════════════════════
   Prototype-only accessibility sweep.
   Lazy-loads axe-core (assets/axe.min.js) and runs it across every
   mode × scenario × theme, deduping violations by rule. Triggered from
   the "Check a11y" button in the prototype dock. Nothing here ships with
   the real app — it drives the prototype via window.__rwA11y.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  const THEMES = ["dark", "light"];
  const IMPACT_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1, null: 0, undefined: 0 };

  let axeReady = null;
  const loadAxe = () =>
    (axeReady ||= new Promise((resolve, reject) => {
      if (window.axe) return resolve();
      const s = document.createElement("script");
      s.src = "./assets/axe.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("could not load assets/axe.min.js"));
      document.head.appendChild(s);
    }));

  // two RAFs so the synchronous innerHTML re-render is laid out before axe reads it
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const sweep = async (onProgress) => {
    await loadAxe();
    const rw = window.__rwA11y;
    if (!rw) throw new Error("prototype hook (__rwA11y) missing");

    const saved = rw.snapshot();
    const savedTheme = document.documentElement.dataset.theme;
    const findings = new Map(); // ruleId -> { rule, impact, help, helpUrl, nodes, states }
    const combos = [];
    for (const theme of THEMES) for (const mode of rw.modes) for (const sc of rw.scenarios) combos.push({ theme, mode, sc });
    // one FULL-DOCUMENT pass per theme — the per-state scans are scoped to the
    // visible workflow panel, which can never see page-level rules (meta-viewport,
    // landmarks, html lang, heading order, the masthead/footer/dialog chrome)
    for (const theme of THEMES) combos.push({ theme, mode: null, sc: null });

    // each re-render restarts the entrance animations (panel-in/drop-in fade
    // opacity 0→1 over .3s). axe would otherwise sample text mid-fade (≈22%
    // opacity) and report bogus dark-on-dark contrast failures — kill all
    // animation/transition timing for the duration of the sweep so every state
    // is measured at its final, settled colours.
    const noMotion = document.createElement("style");
    noMotion.textContent = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";
    document.head.appendChild(noMotion);
    // also skip the scenario-change view transitions (vt-quiet morphs) — 38
    // back-to-back transitions would overlay snapshots while axe samples
    document.documentElement.dataset.vtOff = "1";

    let done = 0;
    try {
      for (const { theme, mode, sc } of combos) {
        document.documentElement.dataset.theme = theme;
        if (mode) {
          rw.setMode(mode);
          rw.setScenario(sc);
        }
        await settle();
        const stateLabel = mode ? `${theme}·${mode}·${sc}` : `${theme}·page`;
        // page scans exclude the sweep's own results panel + the scenario dock —
        // prototype tooling that never ships with the app
        const ctx = mode
          ? document.querySelector(".workflow:not([hidden])") || document.body
          : { include: [["html"]], exclude: [[".a11y-panel"], [".dock"]] };
        const res = await window.axe.run(ctx, {
          resultTypes: ["violations"],
          runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
        });
        for (const v of res.violations) {
          const f =
            findings.get(v.id) ||
            { rule: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: new Set(), states: new Set(), samples: [] };
          for (const n of v.nodes) {
            f.nodes.add(n.target.join(" "));
            // capture the diagnostic data axe attaches (for color-contrast: the
            // computed fg/bg colours + actual vs required ratio) so we can see
            // exactly what's failing without a devtools session
            const data = (n.any && n.any[0] && n.any[0].data) || (n.all && n.all[0] && n.all[0].data);
            if (data && f.samples.length < 4) {
              f.samples.push({ target: n.target.join(" "), state: stateLabel, data });
            }
          }
          f.states.add(stateLabel);
          findings.set(v.id, f);
        }
        done += 1;
        onProgress?.(done, combos.length, stateLabel.replaceAll("·", " · "));
      }
    } finally {
      noMotion.remove();
      delete document.documentElement.dataset.vtOff;
      document.documentElement.dataset.theme = savedTheme;
      rw.setMode(saved.mode);
      rw.setScenario(saved.scenario);
    }

    return {
      states: combos.length,
      findings: [...findings.values()].sort(
        (a, b) => (IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]) || b.nodes.size - a.nodes.size,
      ),
    };
  };

  /* ── results UI ── */
  const panel = document.createElement("div");
  panel.className = "a11y-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="a11y-head">
      <strong>Accessibility</strong>
      <span class="a11y-status"></span>
      <button class="a11y-x" type="button" aria-label="Close">✕</button>
    </div>
    <div class="a11y-body"></div>`;
  document.body.appendChild(panel);
  panel.querySelector(".a11y-x").addEventListener("click", () => { panel.hidden = true; });

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const render = (result) => {
    const body = panel.querySelector(".a11y-body");
    if (!result.findings.length) {
      body.innerHTML = `<p class="a11y-clean">✓ No violations across ${result.states} states (WCAG 2.1 A/AA + best-practice).</p>`;
      return;
    }
    body.innerHTML = result.findings
      .map(
        (f) => `<div class="a11y-finding a11y-${f.impact || "minor"}">
          <div class="a11y-f-top"><span class="a11y-impact">${f.impact || "minor"}</span>
            <a href="${f.helpUrl}" target="_blank" rel="noreferrer">${esc(f.rule)}</a>
            <span class="a11y-count">${f.nodes.size} node${f.nodes.size === 1 ? "" : "s"} · ${f.states.size} state${f.states.size === 1 ? "" : "s"}</span></div>
          <div class="a11y-f-help">${esc(f.help)}</div>
          <div class="a11y-f-target mono">${esc([...f.nodes][0] || "")}</div>
          ${(f.samples || [])
            .map((s) => {
              const d = s.data || {};
              const detail = d.contrastRatio !== undefined
                ? `ratio ${d.contrastRatio} (need ${d.expectedContrastRatio}) · fg ${d.fgColor} on bg ${d.bgColor} · ${d.fontSize || ""} ${d.fontWeight || ""}`
                : JSON.stringify(d);
              return `<div class="a11y-f-target mono" style="opacity:.8">${esc(s.state)} — ${esc(detail)}<br>${esc(s.target)}</div>`;
            })
            .join("")}
        </div>`,
      )
      .join("");
  };

  const runAndShow = async () => {
    panel.hidden = false;
    panel.querySelector(".a11y-body").innerHTML = "";
    const status = panel.querySelector(".a11y-status");
    try {
      const result = await sweep((done, total, label) => {
        status.textContent = `scanning ${done}/${total} — ${label}`;
      });
      const counts = result.findings.reduce((m, f) => ((m[f.impact || "minor"] = (m[f.impact || "minor"] || 0) + 1), m), {});
      status.textContent = result.findings.length
        ? `${result.findings.length} rule${result.findings.length === 1 ? "" : "s"} · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`
        : `clean · ${result.states} states`;
      render(result);
      // full detail for the console
      // eslint-disable-next-line no-console
      console.groupCollapsed(`[a11y] ${result.findings.length} violation rules across ${result.states} states`);
      for (const f of result.findings) console.log(`${(f.impact || "minor").toUpperCase()} ${f.rule} — ${f.help} (${f.nodes.size} nodes)`, { states: [...f.states], targets: [...f.nodes] });
      console.groupEnd();
    } catch (err) {
      status.textContent = "error";
      panel.querySelector(".a11y-body").innerHTML = `<p class="a11y-clean">${esc(String(err.message || err))}</p>`;
    }
  };

  // wire the dock button once the dock exists
  const btn = document.getElementById("dock-a11y");
  if (btn) btn.addEventListener("click", runAndShow);
})();
