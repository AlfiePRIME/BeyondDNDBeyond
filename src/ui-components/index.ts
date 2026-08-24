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

// CanvasUI WebGL effects (installed via `shadcn add @canvas-ui/...`).
// Glitch: broadcast glitch bursts — matches the ported glitch-a/glitch-b
// vocabulary. VHS: worn-tape scanline/chroma-bleed CRT texture. Both are
// dependency-free, degrade gracefully without html-in-canvas support, and
// respect prefers-reduced-motion. Reserve for hero moments and accents.
export { Glitch, type GlitchProps, type GlitchOptions } from "./canvasui/Glitch";
export { VHS, type VHSProps, type VHSOptions } from "./canvasui/VHS";
