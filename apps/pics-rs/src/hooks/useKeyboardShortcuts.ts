import { useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { useUiStore } from "@/stores/uiStore";
import { showSibling } from "@/lib/actions";

/**
 * Global keyboard shortcuts for the viewer (spec §4.1). Navigation, zoom, and
 * the editing tools are wired here. Behaviour is pane-aware: arrows open the
 * prev/next image in the viewer, but only move the highlight in the gallery.
 */
export function useKeyboardShortcuts(): void {
  const zoomBy = useViewerStore((s) => s.zoomBy);
  const setFitToWindow = useViewerStore((s) => s.setFitToWindow);
  const closeImage = useViewerStore((s) => s.closeImage);
  const pushTransform = useViewerStore((s) => s.pushTransform);
  const flip = useViewerStore((s) => s.flip);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);

  const select = useGalleryStore((s) => s.select);
  const siblingPath = useGalleryStore((s) => s.siblingPath);

  /** Prev/next: open the sibling in the viewer, or move the gallery highlight. */
  const navigate = (delta: number) => {
    if (useUiStore.getState().viewMode === "gallery") {
      select(siblingPath(delta));
    } else {
      void showSibling(delta);
    }
  };

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
          navigate(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          navigate(-1);
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
        case "f":
        case "F":
          flip("horizontal");
          break;
        case "v":
        case "V":
          flip("vertical");
          break;
        case "c":
        case "C":
          // Toggle the crop tool (spec §4.3).
          setActiveTool(
            useViewerStore.getState().activeTool === "crop" ? "none" : "crop",
          );
          break;
        case "Escape":
          // Cancel an active tool first; then step back to the gallery if a
          // folder is loaded; otherwise close the image (spec §4.1).
          if (useViewerStore.getState().activeTool !== "none") {
            setActiveTool("none");
          } else if (
            useUiStore.getState().viewMode === "viewer" &&
            useGalleryStore.getState().entries.length > 0
          ) {
            useUiStore.getState().setViewMode("gallery");
          } else {
            closeImage();
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    zoomBy,
    setFitToWindow,
    closeImage,
    pushTransform,
    flip,
    setActiveTool,
    select,
    siblingPath,
  ]);
}
