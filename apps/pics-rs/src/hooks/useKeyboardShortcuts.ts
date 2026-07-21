import { useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";

/**
 * Global keyboard shortcuts for the viewer (spec §4.1). Navigation and zoom are
 * wired here; clipboard (Ctrl/Cmd+C/V) is stubbed pending the clipboard plugin
 * work in a later phase.
 */
export function useKeyboardShortcuts(): void {
  const zoomBy = useViewerStore((s) => s.zoomBy);
  const setFitToWindow = useViewerStore((s) => s.setFitToWindow);
  const closeImage = useViewerStore((s) => s.closeImage);
  const pushTransform = useViewerStore((s) => s.pushTransform);

  const select = useGalleryStore((s) => s.select);
  const siblingPath = useGalleryStore((s) => s.siblingPath);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Ignore shortcuts while typing in an input (e.g. numeric crop fields).
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          select(siblingPath(1));
          break;
        case "ArrowLeft":
        case "ArrowUp":
          select(siblingPath(-1));
          break;
        case "+":
        case "=":
          zoomBy(1.2);
          break;
        case "-":
        case "_":
          zoomBy(1 / 1.2);
          break;
        case "0":
          setFitToWindow(true);
          break;
        case "r":
        case "R":
          pushTransform({
            kind: "rotate",
            degrees: event.shiftKey ? -90 : 90,
          });
          break;
        case "Escape":
          closeImage();
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomBy, setFitToWindow, closeImage, pushTransform, select, siblingPath]);
}
