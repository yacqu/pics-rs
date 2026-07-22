import {
  FolderOpen,
  ImageUp,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Crop,
  Scaling,
  Wand2,
  Copy,
  Save,
  LayoutGrid,
  Undo2,
  Redo2,
  Sun,
  Moon,
  Monitor,
  Loader2,
} from "lucide-react";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { useUiStore } from "@/stores/uiStore";
import { usePreferencesStore, type ThemeChoice } from "@/stores/preferencesStore";
import {
  openImageDialog,
  openFolderDialog,
  copyCurrentToClipboard,
} from "@/lib/actions";

interface ToolButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}

function ToolButton({ label, onClick, disabled, active, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
          : "text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-neutral-50"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-6 w-px bg-neutral-200 dark:bg-neutral-700" />;
}

const THEME_CYCLE: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

export default function Toolbar() {
  const zoomBy = useViewerStore((s) => s.zoomBy);
  const setFitToWindow = useViewerStore((s) => s.setFitToWindow);
  const pushTransform = useViewerStore((s) => s.pushTransform);
  const flip = useViewerStore((s) => s.flip);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const undo = useViewerStore((s) => s.undo);
  const redo = useViewerStore((s) => s.redo);
  const hasImage = useViewerStore((s) => s.current !== null);
  const canUndo = useViewerStore((s) => s.transforms.length > 0);
  const canRedo = useViewerStore((s) => s.redoStack.length > 0);
  const zoom = useViewerStore((s) => s.view.zoom);

  const hasFolder = useGalleryStore((s) => s.entries.length > 0);
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const setExportOpen = useUiStore((s) => s.setExportOpen);
  const busy = useUiStore((s) => s.busy);

  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  /** Toggle a viewer editing tool; clicking the active tool turns it off. */
  const toggleTool = (tool: "crop" | "resize" | "straighten") =>
    setActiveTool(activeTool === tool ? "none" : tool);

  return (
    <header
      data-tauri-drag-region
      className="flex items-center gap-1 bg-white pb-1.5 pl-[80px] pr-4 pt-3 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <ToolButton label="Open image…" onClick={() => void openImageDialog()}>
        <ImageUp className="h-5 w-5" />
      </ToolButton>
      <ToolButton label="Open folder…" onClick={() => void openFolderDialog()}>
        <FolderOpen className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label={viewMode === "gallery" ? "Back to viewer" : "Gallery"}
        onClick={() => setViewMode(viewMode === "gallery" ? "viewer" : "gallery")}
        disabled={!hasFolder}
        active={viewMode === "gallery"}
      >
        <LayoutGrid className="h-5 w-5" />
      </ToolButton>

      <Divider />

      <ToolButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)} disabled={!hasImage}>
        <ZoomOut className="h-5 w-5" />
      </ToolButton>
      <span className="min-w-14 text-center text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
        {Math.round(zoom * 100)}%
      </span>
      <ToolButton label="Zoom in" onClick={() => zoomBy(1.2)} disabled={!hasImage}>
        <ZoomIn className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Fit to window"
        onClick={() => setFitToWindow(true)}
        disabled={!hasImage}
      >
        <Maximize className="h-5 w-5" />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Rotate left"
        onClick={() => pushTransform({ kind: "rotate", degrees: -90 })}
        disabled={!hasImage}
      >
        <RotateCcw className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Rotate right"
        onClick={() => pushTransform({ kind: "rotate", degrees: 90 })}
        disabled={!hasImage}
      >
        <RotateCw className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Flip horizontal"
        onClick={() => flip("horizontal")}
        disabled={!hasImage}
      >
        <FlipHorizontal className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Flip vertical"
        onClick={() => flip("vertical")}
        disabled={!hasImage}
      >
        <FlipVertical className="h-5 w-5" />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Crop"
        onClick={() => toggleTool("crop")}
        disabled={!hasImage}
        active={activeTool === "crop"}
      >
        <Crop className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Resize"
        onClick={() => toggleTool("resize")}
        disabled={!hasImage}
        active={activeTool === "resize"}
      >
        <Scaling className="h-5 w-5" />
      </ToolButton>
      <ToolButton
        label="Straighten"
        onClick={() => toggleTool("straighten")}
        disabled={!hasImage}
        active={activeTool === "straighten"}
      >
        <Wand2 className="h-5 w-5" />
      </ToolButton>

      <Divider />

      <ToolButton label="Undo" onClick={undo} disabled={!canUndo}>
        <Undo2 className="h-5 w-5" />
      </ToolButton>
      <ToolButton label="Redo" onClick={redo} disabled={!canRedo}>
        <Redo2 className="h-5 w-5" />
      </ToolButton>

      <Divider />

      <ToolButton
        label={busy ? "Copying…" : "Copy to clipboard"}
        onClick={() => void copyCurrentToClipboard()}
        disabled={!hasImage || busy !== null}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Copy className="h-5 w-5" />
        )}
      </ToolButton>
      <ToolButton
        label="Export / Save…"
        onClick={() => setExportOpen(true)}
        disabled={!hasImage}
      >
        <Save className="h-5 w-5" />
      </ToolButton>

      <div className="ml-auto" />

      <ToolButton
        label={`Theme: ${theme} (click to change)`}
        onClick={() => setTheme(THEME_CYCLE[theme])}
      >
        <ThemeIcon className="h-5 w-5" />
      </ToolButton>
    </header>
  );
}
