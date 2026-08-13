import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { formatIdentifyTitle } from "../../presentation/identify-title.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { NeedsInput, StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { ParsedIdentifyResult } from "../../types/identify.ts";
import { IdentifyDrawer } from "./identify-drawer.tsx";

const IDENTIFY_ACTIVITY_KEY = "identify";

type IdentifyFormProps = {
  containerId?: string;
  inputId?: string;
  pageDrop?: PageFileDrop | null;
};

const IdentifyForm = ({
  containerId = "identify-container",
  inputId = "identify-input-picker",
  pageDrop,
}: IdentifyFormProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ParsedIdentifyResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const handledDropRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const selectFile = useCallback((next: File) => {
    abortRef.current?.abort();
    setFile(next);
    setResult(null);
    setError("");
  }, []);

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    const selected = pageDrop.files.at(-1);
    if (selected) selectFile(selected);
  }, [pageDrop, selectFile]);

  useEffect(() => {
    if (busy) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { stage: "Identify ROM", state: "running" });
    else if (error) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "failed" });
    else if (result) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { stage: "ROM identified", state: "done" });
    else if (file) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "idle" });
  }, [busy, error, file, result]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );

  const run = async () => {
    if (!(file && !busy)) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const { identifyRom } = await import("../../platform/browser/browser-api.ts");
      setResult(await identifyRom(file, file.name, { signal: abort.signal }));
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="panel" id={containerId}>
      <UnifiedDropZone
        addLabel="Replace the ROM"
        big={!file}
        disabled={busy}
        heroLabel="Drop a ROM to identify it"
        heroLabelCoarse="Tap to add a ROM"
        info={<p>The title database stays on this device. ROM bytes never leave the browser.</p>}
        inputId={inputId}
        lead={{ line1: "ui.hero.identifyThesis", line2: "ui.hero.identifyThesis2" }}
        multiple={false}
        onFiles={(files) => {
          const selected = files.at(-1);
          if (selected) selectFile(selected);
        }}
        supported={[
          {
            extensions: [
              "nes",
              "sfc",
              "smc",
              "gb",
              "gbc",
              "gba",
              "n64",
              "z64",
              "v64",
              "a26",
              "a52",
              "a78",
              "lnx",
              "32x",
              "ngp",
              "ngc",
              "gg",
              "sms",
              "md",
              "pce",
              "zip",
              "7z",
            ],
            label: "ROMs and ROM archives",
          },
        ]}
      />
      <StepSection num="0x02" title="ROM">
        {file ? (
          <div className="cards">
            <FileCard
              meta={<span className="fsize mono">{formatByteSize(file.size)}</span>}
              name={<span className="nm mono">{file.name}</span>}
              onRemove={() => {
                abortRef.current?.abort();
                setFile(null);
                setResult(null);
                setError("");
              }}
              removeLabel="Remove ROM"
            />
          </div>
        ) : (
          <NeedsInput onClick={() => document.getElementById(inputId)?.click()}>
            Add a ROM in the <b className="hexref mono">0x01</b> drop zone.
          </NeedsInput>
        )}
      </StepSection>
      <StepSection fault={!!error} num="0x03" title="Identify" woven={!!result}>
        {error ? (
          <Notice level="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        ) : null}
        <RunButton disabled={!file || busy} icon={<Search aria-hidden="true" />} onClick={() => void run()}>
          {busy ? "Identifying ROM…" : "Identify ROM"}
        </RunButton>
        {result ? (
          <div className="cards">
            {result.matches.length ? (
              result.matches.map((match) => (
                <FileCard
                  description={`${match.platform} · ${match.algorithm.toUpperCase()} · ${match.variant}`}
                  key={`${match.platform}:${match.name}`}
                  name={<span className="nm">{formatIdentifyTitle(match.name)}</span>}
                  state={result.status === "ambiguous" ? "warn" : "ok"}
                />
              ))
            ) : (
              <Notice level="warn">No title in the local database matched this ROM.</Notice>
            )}
            <IdentifyDrawer identification={result} />
            <div className="card">
              <ChecksumList defaultOpen={false} label="Checksums">
                {Object.entries(result.checksums).map(([algorithm, checksum]) => (
                  <ChecksumRow key={algorithm} label={algorithm.toUpperCase()} value={checksum} />
                ))}
              </ChecksumList>
            </div>
          </div>
        ) : null}
      </StepSection>
    </section>
  );
};

export { IdentifyForm };
export type { IdentifyFormProps };
