"use client";

import { Html } from "@react-three/drei";
import styles from "./ObjectRevealCard.module.css";

export interface ObjectRevealCardProps {
  /** Purely a data-testid disambiguator (`object-reveal-card-${objectId}`) —
   * a real Playwright check has no other way to find a specific object's own
   * card among several simultaneously-revealed ones, the same
   * verification-only reasoning as ChatBubbleProps.userId. Never read by
   * this component for anything else. */
  objectId: string;
  /** The FINAL world position for the `<Html>` anchor — already the
   * object's own worldX/topY/worldZ (the exact formula MapSurface.tsx's own
   * ObjectMarker uses for this same object) PLUS whatever vertical
   * clearance keeps the card from overlapping the object's modeled
   * geometry. Unlike ChatBubble's/DmBookProp's own `position` props (each a
   * raw floor/table-height base, with their OWN fixed clearance constant
   * added internally), that clearance can't be a single fixed constant
   * here: cellSize varies per map (mapFit.ts fits every grid onto the same
   * physical table), so "far enough above the object" has to scale with
   * THIS map's own cellSize — a value GameRoom.tsx already has in scope
   * exactly where it computes worldX/worldZ/topY for this object, so it
   * folds the scaled clearance in there rather than this component
   * re-deriving cellSize from nothing. */
  position: readonly [number, number, number];
  /** Which of map_objects.behavior_config's two reveal actions this card is
   * showing — see MapObjectBehavior's own doc comment (@/data-access) for
   * the full behavior_config shape this mirrors. */
  kind: "text" | "image";
  /** behavior.content: reveal_text's hidden message, or reveal_image's
   * image URL — MapPanel.tsx's own old inline rendering read this exact
   * same field the exact same way. */
  content: string;
}

/**
 * A DM-authored reveal_text/reveal_image behavior's own triggered content,
 * floating above the object's real spot on the table — replacing
 * MapPanel.tsx's old flat, position-blind inline paragraph/image inside the
 * "Interactive objects" list. Modeled directly on ChatBubble.tsx's own
 * anchoring pattern: `<Html transform={false} center>`, a non-perspective-
 * transformed DOM overlay pinned to a 3D world position, wrapped in a plain
 * `<group position={...}>` — mounted by GameRoom.tsx as a `<Canvas>` sibling
 * of GameTableScene, the exact same mounting layer ChatBubble already uses.
 *
 * A passive readout, not a control: `pointerEvents="none"` (ChatBubble's own
 * reasoning) so it never intercepts a click meant for the object or map cell
 * beneath it — the object's own trigger button and state badge still live in
 * MapPanel's flat list, unchanged; only the revealed CONTENT moved from
 * there to here.
 */
export function ObjectRevealCard({ objectId, position, kind, content }: ObjectRevealCardProps) {
  return (
    <group position={position as [number, number, number]}>
      <Html center transform={false} zIndexRange={[400, 0]} pointerEvents="none">
        <div className={styles.card} data-testid={`object-reveal-card-${objectId}`}>
          {kind === "text" ? (
            <p className={styles.text}>{content}</p>
          ) : (
            // A DM-entered arbitrary URL — next/image's optimizer needs an
            // allowlisted host, which can't exist for free-form input.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={content} alt="Revealed image" className={styles.image} />
          )}
        </div>
      </Html>
    </group>
  );
}
