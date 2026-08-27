// Public entry point for the ui-components module. Shared design-system
// components (buttons, panels, inputs, modals, badges) built on the design
// tokens (./tokens.css, applied globally via src/app/globals.css) and
// CanvasUI. Other modules must import from this barrel only.
export const MODULE_NAME = "ui-components" as const;

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Panel, type PanelProps, type PanelTone } from "./Panel";
export { TextInput, type TextInputProps } from "./TextInput";
export { Select, type SelectProps } from "./Select";
export { Modal, type ModalProps } from "./Modal";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { SectionHeader, type SectionHeaderProps } from "./SectionHeader";
export { ChoiceCard, type ChoiceCardProps } from "./ChoiceCard";
export { ChatText, type ChatTextProps } from "./ChatText";
export {
  parseChatFormatting,
  CHAT_COLOR_CODES,
  type ChatSpan,
  type ChatFormatFlag,
} from "./chatFormatting";
export { computeChatBubbleDurationMs } from "./chatBubbleTiming";

// CanvasUI WebGL effects (installed via `shadcn add @canvas-ui/...`).
// Glitch: broadcast glitch bursts — matches the ported glitch-a/glitch-b
// vocabulary. VHS: worn-tape scanline/chroma-bleed CRT texture. ForceField:
// energy-shield lattice with click shockwaves. Peel: peels the page back
// from an edge in 3D, book-page style. All four capture STATIC HTML content
// via the experimental html-in-canvas API and degrade gracefully without
// it (confirmed NOT present in this project's real target Chromium — see
// Droplets' own doc comment for the direct evidence). Reserve for hero
// moments and accents.
export { Glitch, type GlitchProps, type GlitchOptions } from "./canvasui/Glitch";
export { VHS, type VHSProps, type VHSOptions } from "./canvasui/VHS";
export { ForceField, type ForceFieldProps, type ForceFieldOptions } from "./canvasui/ForceField";
export { Peel, type PeelProps, type PeelOptions } from "./canvasui/Peel";
// Droplets (Weather & Enemies C2): rain-on-glass refraction over the Game
// Room's own live R3F canvas — captured directly via WebGL texImage2D, NOT
// through the html-in-canvas path the other four use (see its own doc
// comment for the full spike writeup). Reused as-is by C3's thunderstorm.
export { Droplets, type DropletsProps, type DropletsOptions } from "./canvasui/Droplets";
