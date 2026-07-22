import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
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
  MoreHorizontal,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { useUiStore } from "@/stores/uiStore";
import { usePreferencesStore, type ThemeChoice } from "@/stores/preferencesStore";
import { rafThrottle } from "@/lib/rafThrottle";
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
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
  return <div className="mx-1 h-6 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />;
}

const THEME_CYCLE: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

/** A single action, used both as an inline `ToolButton` and as an overflow-menu row. */
interface ToolAction {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

/**
 * A collapsible cluster of actions (spec testing notes #1: "header should be
 * smart and size responsive"). `width` is the group's approximate rendered
 * width in px (buttons are a fixed 36px, `gap-1` between them is 4px) —
 * used to decide, without a full measurement pass, how many groups fit
 * before the rest collapse into the overflow menu.
 */
interface ToolGroup {
  id: string;
  width: number;
  actions: ToolAction[];
}

const BTN = 36;
const GAP = 4;
const DIVIDER_UNIT = 9 + GAP * 2; // divider's own width + the gap on both sides
const THEME_W = BTN;
const OVERFLOW_W = BTN;

function groupWidth(count: number): number {
  return count * BTN + Math.max(0, count - 1) * GAP;
}

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

  // --- Collapsible groups, ordered by priority (first = collapses first). ---
  const rotateFlip: ToolGroup = {
    id: "rotateFlip",
    width: groupWidth(4),
    actions: [
      {
        key: "rotate-left",
        label: "Rotate left",
        icon: RotateCcw,
        onClick: () => pushTransform({ kind: "rotate", degrees: -90 }),
        disabled: !hasImage,
      },
      {
        key: "rotate-right",
        label: "Rotate right",
        icon: RotateCw,
        onClick: () => pushTransform({ kind: "rotate", degrees: 90 }),
        disabled: !hasImage,
      },
      {
        key: "flip-h",
        label: "Flip horizontal",
        icon: FlipHorizontal,
        onClick: () => flip("horizontal"),
        disabled: !hasImage,
      },
      {
        key: "flip-v",
        label: "Flip vertical",
        icon: FlipVertical,
        onClick: () => flip("vertical"),
        disabled: !hasImage,
      },
    ],
  };

  const editTools: ToolGroup = {
    id: "editTools",
    width: groupWidth(3),
    actions: [
      {
        key: "crop",
        label: "Crop",
        icon: Crop,
        onClick: () => toggleTool("crop"),
        disabled: !hasImage,
        active: activeTool === "crop",
      },
      {
        key: "resize",
        label: "Resize",
        icon: Scaling,
        onClick: () => toggleTool("resize"),
        disabled: !hasImage,
        active: activeTool === "resize",
      },
      {
        key: "straighten",
        label: "Straighten",
        icon: Wand2,
        onClick: () => toggleTool("straighten"),
        disabled: !hasImage,
        active: activeTool === "straighten",
      },
    ],
  };

  const copyExport: ToolGroup = {
    id: "copyExport",
    width: groupWidth(2),
    actions: [
      {
        key: "copy",
        label: busy ? "Copying…" : "Copy to clipboard",
        icon: busy ? Loader2 : Copy,
        onClick: () => void copyCurrentToClipboard(),
        disabled: !hasImage || busy !== null,
      },
      {
        key: "export",
        label: "Export / Save…",
        icon: Save,
        onClick: () => setExportOpen(true),
        disabled: !hasImage,
      },
    ],
  };

  const undoRedo: ToolGroup = {
    id: "undoRedo",
    width: groupWidth(2),
    actions: [
      { key: "undo", label: "Undo", icon: Undo2, onClick: undo, disabled: !canUndo },
      { key: "redo", label: "Redo", icon: Redo2, onClick: redo, disabled: !canRedo },
    ],
  };

  // Collapse priority: last entry collapses first when space runs out, i.e.
  // these are added back (kept visible) in this order as width allows.
  const collapsible = useMemo(
    () => [undoRedo, copyExport, editTools, rotateFlip],
    [hasImage, canUndo, canRedo, busy, activeTool],
  );

  // --- Width measurement: decide how many collapsible groups fit. ---
  const headerRef = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(Infinity);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = rafThrottle(() => setContentWidth(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      measure.cancel();
    };
  }, []);

  // Fixed part of the header that's always shown: open/folder/gallery, the
  // divider before it, zoom controls, and the theme button (with its own
  // leading gap, no divider).
  const CORE_W = groupWidth(3);
  const ZOOM_W = BTN + GAP + 56 /* percentage label, min-w-14 */ + GAP + BTN + GAP + BTN;
  const baseUsed = 80 + 16 + CORE_W + DIVIDER_UNIT + ZOOM_W + GAP + THEME_W;

  const totalCollapsibleWidth = collapsible.reduce(
    (sum, g) => sum + DIVIDER_UNIT + g.width,
    0,
  );

  // IDs rather than object references: `collapsible` is memoized, so on a
  // render where its deps didn't change it returns *last* render's group
  // objects while `rotateFlip`/`editTools`/etc. below are freshly created
  // literals every render. Comparing those by reference (`.includes(group)`)
  // fails on almost every render (any resize, zoom-%, fullscreen toggle...)
  // and silently drops every collapsible button from the header — the bug
  // behind "editing buttons disappeared" / "lost all icons in fullscreen".
  // Comparing by the group's stable `id` sidesteps identity entirely.
  let visibleIds: Set<string>;
  let overflowIds: Set<string>;
  if (contentWidth >= baseUsed + totalCollapsibleWidth) {
    // Everything fits — no overflow menu needed at all.
    visibleIds = new Set(collapsible.map((g) => g.id));
    overflowIds = new Set();
  } else {
    const budget = contentWidth - baseUsed - OVERFLOW_W - GAP;
    let used = 0;
    visibleIds = new Set();
    overflowIds = new Set();
    for (const group of collapsible) {
      const cost = DIVIDER_UNIT + group.width;
      if (used + cost <= budget) {
        visibleIds.add(group.id);
        used += cost;
      } else {
        overflowIds.add(group.id);
      }
    }
  }

  // --- Overflow menu open/close (click-outside + Escape to dismiss). ---
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOverflowOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

  // Close the menu automatically once everything fits again (window widened).
  useEffect(() => {
    if (overflowIds.size === 0) setOverflowOpen(false);
  }, [overflowIds.size]);

  // --- Double-click the header to zoom/restore the window, like the native
  // macOS title bar (testing notes #1). `data-tauri-drag-region` makes the
  // header draggable, but with the Overlay title bar there is no real native
  // title bar to inherit the double-click-to-zoom gesture from, so we wire it
  // up explicitly via `toggleMaximize`. ---
  function onHeaderDoubleClick(e: React.MouseEvent<HTMLElement>) {
    // Only trigger from the drag region itself, not from a button click.
    if ((e.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().toggleMaximize();
  }

  return (
    <header
      ref={headerRef}
      data-tauri-drag-region
      onDoubleClick={onHeaderDoubleClick}
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

      {/* Collapsible groups, rendered in their normal relative order (not
          priority order) so the toolbar reads the same regardless of which
          ones fit. */}
      {[rotateFlip, editTools, undoRedo, copyExport]
        .filter((g) => visibleIds.has(g.id))
        .map((group) => (
          <div key={group.id} className="contents">
            <Divider />
            {group.actions.map((a) => (
              <ToolButton
                key={a.key}
                label={a.label}
                onClick={a.onClick}
                disabled={a.disabled}
                active={a.active}
              >
                <a.icon className="h-5 w-5" />
              </ToolButton>
            ))}
          </div>
        ))}

      {overflowIds.size > 0 && (
        <>
          <Divider />
          <div ref={overflowRef} className="relative">
            <ToolButton
              label="More actions"
              onClick={() => setOverflowOpen((v) => !v)}
              active={overflowOpen}
            >
              <MoreHorizontal className="h-5 w-5" />
            </ToolButton>
            {overflowOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
              >
                {[rotateFlip, editTools, undoRedo, copyExport]
                  .filter((g) => overflowIds.has(g.id))
                  .flatMap((g) => g.actions)
                  .map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      role="menuitem"
                      disabled={a.disabled}
                      onClick={() => {
                        a.onClick();
                        setOverflowOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        a.active
                          ? "text-blue-700 dark:text-blue-300"
                          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
                      }`}
                    >
                      <a.icon className="h-4 w-4 shrink-0" />
                      {a.label}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

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
