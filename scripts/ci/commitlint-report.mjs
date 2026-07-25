//
// A commitlint formatter (`commitlint --format`) that writes the machine
// readable report the pull request title gate renders from.
//
// commitlint's own formatter returns one human paragraph - the offending title,
// a glyph, a message and a rule name per line, wrapped in ANSI colour. Parsing
// that back apart to say anything specific about a failure means matching on
// prose that exists to be read, not consumed. The report handed to a formatter
// is already structured (`results[].errors[]` with `name`, `level` and
// `message`), so this one writes it out as JSON and lets the gate branch on
// rule names.
//
// It is passed by path rather than package name, so nothing has to be installed
// for it to load - see the title gate's step in `.github/workflows/pull-request.yml`.
//
// Optional env:
//   LINT_REPORT_FILE  where to write the JSON report; skipped when unset
import { writeFileSync } from "node:fs";

const { LINT_REPORT_FILE = "" } = process.env;

const label = (problem) => (problem.level === 2 ? "error" : "warning");

// What lands in the workflow log. The comment on the pull request is built by
// the gate from the JSON; this only has to be readable by whoever opens the run.
function human(report) {
  return report.results
    .flatMap((result) => [
      `input: ${result.input}`,
      ...[...result.errors, ...result.warnings].map(
        (problem) => `  ${label(problem)}  ${problem.message}  [${problem.name}]`,
      ),
      `  ${report.errorCount} error(s), ${report.warningCount} warning(s)`,
    ])
    .join("\n");
}

export default function format(report) {
  if (LINT_REPORT_FILE) {
    writeFileSync(LINT_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  }
  return human(report);
}
