// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";

describe("LogDialog", () => {
  it("prefills a GitHub issue and names the diagnostic attachment", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog
          issueHref="https://github.com/example/rom-weaver/"
          onClose={() => undefined}
          onLevelChange={() => undefined}
          open={false}
          threads={4}
        />
      </RomWeaverSettingsProvider>,
    );

    const report = container.querySelector<HTMLAnchorElement>(".log-report");
    expect(report?.textContent).toBe("Report issue + log");
    const issueUrl = new URL(report?.getAttribute("href") || "");
    expect(issueUrl.pathname).toBe("/example/rom-weaver/issues/new");
    expect(issueUrl.searchParams.get("body")).toContain("rom-weaver-diagnostic.txt");
  });
});
