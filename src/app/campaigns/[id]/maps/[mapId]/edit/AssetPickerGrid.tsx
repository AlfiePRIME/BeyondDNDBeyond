import { ChoiceCard } from "@/ui-components";
import type { PaletteAsset } from "./lib/assetUrl";
import styles from "./editor.module.css";

export interface AssetPickerGridProps {
  /** The roster to render — always the SAME array the caller already has
   * (the sidebar Place-mode palette's own `assets` prop), never a second,
   * separately-curated list. Any future filtering/grouping of the roster
   * should happen once, before this component, so every consumer stays in
   * sync automatically. */
  assets: readonly PaletteAsset[];
  /** Highlights one card as the current pick (ChoiceCard's `selected`).
   * Omit for a picker with no persistent "current selection" concept — a
   * one-shot popover where picking places immediately and nothing stays
   * highlighted afterward. */
  selectedAssetId?: string | null;
  /** Called with the picked asset's id. Callers decide what "picking" means
   * — the sidebar palette treats it as "change the active selection", the
   * Ctrl+click quick-place popover treats it as "place now and close". */
  onPick: (assetId: string) => void;
  /** data-testid on the grid's own container element. */
  gridTestId: string;
  /** Prefix for each card's data-testid: `${cardTestIdPrefix}-${asset.id}`.
   * Kept a required, separate prop (rather than derived from gridTestId) so
   * two instances of this component rendered at once — the sidebar palette
   * and the quick-place popover — can never collide on the same testids. */
  cardTestIdPrefix: string;
  /** Layout class for the grid container itself — callers own their own
   * sizing/scroll behavior (the sidebar's `.assetGrid` and the popover's
   * `.quickPlacePopoverGrid` cap height and scroll independently). */
  className: string;
}

/**
 * The shared roster of placeable assets, rendered as the exact ChoiceCard
 * grid this editor has always used for Place-mode's sidebar palette —
 * pulled out into its own component (Map Editor Batch A1) so the Ctrl+click
 * quick-place popover reuses this same rendering instead of maintaining a
 * second copy, and so a later consumer (Batch A10's Game Room live-placement
 * picker) has a real, reusable component to build on rather than one-off
 * JSX inlined in the Ctrl+click path alone.
 */
export function AssetPickerGrid({
  assets,
  selectedAssetId = null,
  onPick,
  gridTestId,
  cardTestIdPrefix,
  className,
}: AssetPickerGridProps) {
  return (
    <div className={className} data-testid={gridTestId}>
      {assets.map((asset) => (
        <ChoiceCard
          key={asset.id}
          className={styles.assetCard}
          selected={asset.id === selectedAssetId}
          onClick={() => onPick(asset.id)}
          title={asset.name}
          meta={asset.source_type === "preset" ? "Built-in" : "Upload"}
          data-testid={`${cardTestIdPrefix}-${asset.id}`}
        />
      ))}
    </div>
  );
}
