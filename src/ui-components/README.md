# ui-components

Shared design-system components (buttons, panels, inputs, modals, badges, section headers)
built on the design tokens and CanvasUI. Every UI-building prompt reuses these rather than
hand-rolling new styles. Module boundary formalized in Prompt 2; populated in Prompt 3.

`ChatText` (Chat & Summary B2) renders a raw Minecraft-style formatted chat message
("&cHello &lworld&r!") as real styled DOM spans — `chatFormatting.ts` is the pure,
React-free parser behind it (color codes covering this app's own accent palette plus a
handful of standard colors, `&l`/`&o`/`&n`/`&m` bold/italic/underline/strikethrough, `&k`
obfuscated, `&r` reset), and `chatObfuscationClock.ts` drives every obfuscated span's
continuously-scrambling glyphs off one shared page-wide interval rather than one per span.
No formatting-code toolbar UI — codes are hand-typed by players.
