import {
  FolderOpen,
  ImageUp,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  RotateCw,
  Undo2,
  Redo2,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { useViewerStore } from "@/stores/viewerStore";
import { usePreferencesStore, type ThemeChoice } from "@/stores/preferencesStore";
import { openImageDialog, openFolderDialog } from "@/lib/actions";

interface ToolButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolButton({ label, onClick, disabled, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-neutral-50"
    >
      {children}
    </button>
  );
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
  const undo = useViewerStore((s) => s.undo);
  const redo = useViewerStore((s) => s.redo);
  const hasImage = useViewerStore((s) => s.current !== null);
  const canUndo = useViewerStore((s) => s.transforms.length > 0);
  const canRedo = useViewerStore((s) => s.redoStack.length > 0);
  const zoom = useViewerStore((s) => s.view.zoom);

  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <header className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
      <ToolButton label="Open image…" onClick={() => void openImageDialog()}>
        <ImageUp className="h-5 w-5" />
      </ToolButton>
      <ToolButton label="Open folder…" onClick={() => void openFolderDialog()}>
        <FolderOpen className="h-5 w-5" />
      </ToolButton>

      <div className="mx-1 h-6 w-px bg-neutral-200 dark:bg-neutral-700" />

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

      <div className="mx-1 h-6 w-px bg-neutral-200 dark:bg-neutral-700" />

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

      <div className="mx-1 h-6 w-px bg-neutral-200 dark:bg-neutral-700" />

      <ToolButton label="Undo" onClick={undo} disabled={!canUndo}>
        <Undo2 className="h-5 w-5" />
      </ToolButton>
      <ToolButton label="Redo" onClick={redo} disabled={!canRedo}>
        <Redo2 className="h-5 w-5" />
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
