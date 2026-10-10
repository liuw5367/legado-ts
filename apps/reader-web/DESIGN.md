# Reader web design

## 1. Visual theme and atmosphere

Legado Reader uses a quiet ink-on-paper direction for long reading sessions: warm neutral surfaces, restrained brown ink in light mode, and muted amber ink in night mode. The application is utility-first, with a clear reading column, low visual noise, and no decorative motion.

## 2. Color palette and roles

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--background` | `#f6f3ed` | `#171513` | Page canvas |
| `--card` | `#fffefa` | `#211f1c` | Reading and form surfaces |
| `--foreground` | `#24211d` | `#f3eee7` | Primary text |
| `--muted` | `#70685e` | `#b8afa4` | Supporting text |
| `--border` | `#ded8ce` | `#3c3832` | Dividers and control outlines |
| `--primary` | `#76542e` | `#d6aa72` | Actions and links |

The system theme resolves to light or dark through `prefers-color-scheme`; an account setting can override it.

Page titles use 18px, section headings 14px, and supporting text 12px. Short title and subtitle pairs sit on one row when space permits. Navigation, return, and reader controls share Lucide outline icons.

## 3. Typography rules

The stack is `ui-sans-serif`, system UI, and `PingFang SC`/`Noto Sans SC` fallbacks for Chinese text. Headings use a compact negative letter spacing only at display sizes. Reading text starts at 18px with a 1.9 line height, both adjustable per account. Body reading lines stay within a 680px column.

## 4. Component styling

Buttons use a 0.5rem radius, solid primary fill for the main action, and a one-pixel outline for secondary actions. Press feedback is a small downward transform, and focus uses a visible primary outline. Cards are reserved for forms, settings, source panels, and result rows. Inputs inherit the current surface and foreground tokens.

## 5. Layout principles

Pages use a single reading column capped at 680px, with a two-level rhythm of 0.75rem and 1.25rem. The header aligns to the same content width. Search and settings collapse to one column below 720px; reader controls wrap before the text column becomes cramped.

The TOC heading, actions, and filter share one sticky area, below the desktop app header. Narrow actions wrap without hiding the return button. Reader top and bottom bars are fixed overlays, hidden initially and toggled by a text tap. The bottom bar uses two rows: previous / character count / next, then four icon shortcuts for TOC, sources, settings, and theme. Safe area padding and permanent text end padding keep the last paragraph reachable. Toggling bars must not move text or scroll position.

Use `viewport-fit=cover` and all four safe-area insets. The reader top bar adds 8px of breathing room beyond the top inset, with solid surfaces for legibility. Result and source rows constrain their text column with `min-width: 0`; long URLs truncate within that column while actions remain aligned. The selected chapter is bold in both TOC views.

## 6. Depth and elevation

Light surfaces use a small neutral shadow only where a card needs separation. Dark surfaces use a luminance step between canvas and card, with borders kept quiet. No gradient or glass treatment is used.

## 7. Do and do not

- Do keep chapter text calm, spacious, and left aligned.
- Do expose system, light, and night modes in a keyboard reachable select.
- Do keep source and position identity visible when switching editions.
- Do preserve the same semantic tokens in every page.
- Do use real empty, loading, and error copy from the product flow.
- Do not add decorative gradients, oversized hero sections, or automatic page animations.
- Do not hide source choice behind a modal when an inline panel is enough.

## 8. Responsive behavior

The supported narrow layout is 320px and up. Header secondary text hides below 720px, controls wrap, and range inputs become full width in the settings page. Interactive controls keep a 44px or larger hit area. Desktop uses the same structure with more breathing room, not a separate visual language.

## 9. Agent prompt guide

Use these existing tokens and values when extending the UI:

- Canvas: `var(--background)`
- Surface: `var(--card)`
- Text: `var(--foreground)`
- Supporting text: `var(--muted)`
- Divider: `var(--border)`
- Action: `var(--primary)`
- Radius: `0.5rem` controls, `0.75rem` content cards
- Reading type: 18px, line height 1.9, max width 680px

Example prompts:

1. Add a source detail panel using `var(--card)`, a `0.75rem` radius, a `1px solid var(--border)` outline, and a two-column layout that collapses below 720px.
2. Add a reader control using `var(--foreground)` labels, `var(--muted)` helper copy, and a `var(--primary)` range accent. Keep the hit area at least 44px.
3. Add an empty reading state with a dashed `var(--border)` outline, 2rem padding, and one direct action link in `var(--primary)`.
