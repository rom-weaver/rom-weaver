import { useEffect, useState } from "react";

/** Reading line: a heading counts as current once it passes under the masthead. */
const HEADING_BAND_PX = 108;

/**
 * Track which section of a long document the reader is currently in, so the
 * section rail can mark it. Returns the id of the last heading scrolled past,
 * falling back to the first section at the top of the document.
 */
const useActiveSection = (sections: readonly { id: string }[], active: boolean): string => {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    if (!active || sections.length === 0) return undefined;
    let frame = 0;
    const readActiveSection = () => {
      frame = 0;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        setActiveId(sections.at(-1)?.id ?? "");
        return;
      }
      let current = "";
      for (const { id } of sections) {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= HEADING_BAND_PX) current = id;
      }
      setActiveId(current || (sections[0]?.id ?? ""));
    };
    const scheduleRead = () => {
      if (frame) return;
      frame = requestAnimationFrame(readActiveSection);
    };
    readActiveSection();
    window.addEventListener("scroll", scheduleRead, { passive: true });
    window.addEventListener("resize", scheduleRead);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleRead);
      window.removeEventListener("resize", scheduleRead);
    };
  }, [active, sections]);

  return activeId;
};

export { useActiveSection };
