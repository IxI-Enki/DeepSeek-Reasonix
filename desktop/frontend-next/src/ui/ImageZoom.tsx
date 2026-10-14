import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { useEscape } from "./dismiss";

/** One enlarged-picture layer for every picture the transcript shows small. The
 *  opener is remembered so closing, by Escape, a click or Enter, hands focus
 *  back to it; while open, focus is inside the layer rather than behind it. */
export function useImageZoom(): { zoom: (src: string, opener: HTMLElement | null) => void; layer: ReactNode } {
  const [open, setOpen] = useState<{ src: string; opener: HTMLElement | null } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen((was) => {
      was?.opener?.focus();
      return null;
    });
  }, []);
  useEscape(!!open, close);
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  const zoom = useCallback((src: string, opener: HTMLElement | null) => setOpen({ src, opener }), []);
  const layer = open && (
    <div
      ref={box}
      className="tshot-full"
      data-action-click="image.close"
      data-action-keydown="image.close"
      role="dialog"
      aria-modal="true"
      aria-label={t("放大的图片")}
      tabIndex={-1}
      onClick={close}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        close();
      }}
    >
      <img src={open.src} alt={t("放大的图片")} />
    </div>
  );
  return { zoom, layer };
}
