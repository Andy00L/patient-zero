# Patient Zero: token sheet

The single source of truth for every surface in this project. Components read
tokens; they never carry literal colors, durations, or radii. If a screen needs
a value that is not here, the value gets added here first with its rationale,
or the screen is wrong.

Every contrast pair was computed before a single component was written, so no
screen can fail the check later. The numbers in this document are measured, not
estimated: see "Contrast ledger".

**House style, one line:** a warm-ink field instrument, dense real data set in
Technor and Tabular, one amber signal, one light source, and motion only where
it explains something.

---

## 1. Frame

| Decision | Value | Why |
| --- | --- | --- |
| Register | Field instrument. A console that reads a live registry, not a marketing site and not a SaaS dashboard. | The product answers "who is exposed, through which path, at what hop". That is an instrument reading, so the surface is an instrument. |
| Density | **Dense.** Section padding 24px, row height 36px, control height 32px. | Every screen shows real package keys, versions, hop counts, and timestamps. Airy spacing would push three rows below the fold and make the tool useless. |
| Theme scope | **One dark theme. No toggle.** | A monitoring instrument has one correct environment. Two themes double the contrast matrix for no product gain, and the sun-moon toggle is a rejected pattern. |
| Hero moment | The propagation trace on `/` (section 7). | It is the answer the product exists to give. |
| Stack | Next.js App Router, Tailwind 4, tokens as CSS custom properties in `src/app/globals.css`. | Tailwind 4 reads CSS variables natively, so one token sheet drives both utility classes and hand-written CSS with no duplication. |

---

## 2. Palette

Seven roles. No eighth color exists.

| Role | Token | Hex | Use |
| --- | --- | --- | --- |
| Field | `--color-field` | `#161211` | Page ground. The only full-bleed color. |
| Raised surface | `--color-surface` | `#1F1A18` | Panels, cards, menus, table headers. |
| Recessed surface | `--color-sunken` | `#100D0C` | Inset trays: the scrubber track, code and lockfile wells, input interiors. |
| Hairline | `--color-edge` | `#2A2422` | Self-colored 1px separations. Part of the shadow stack, not a border of its own. |
| Hairline, strong | `--color-edge-strong` | `#3A322F` | The one step up, for a lifted surface's outline and a focused input's rim. |
| Ink | `--color-ink` | `#F2EDE9` | Primary text, headings, the value in a data row. |
| Muted ink | `--color-ink-muted` | `#A8A09B` | Secondary prose, inline labels, a value that resolved but carries no finding. |
| Faint ink | `--color-ink-faint` | `#8C8178` | Eyebrows, units, disabled text, the lowest tier that is still readable. |
| Accent, soft | `--color-accent` | `#C8873F` | The one signal color. Exposure, the active scrubber position, the focus ring, the swept arc. |
| Accent, deep | `--color-accent-deep` | `#8A5A26` | Accent pressed state, filled-button ground, the trace's cold segments. |
| Reserved | `--color-critical` | `#CD6555` | Advisory severity only. Never a verdict color (section 4). |
| Destructive | `--color-destructive` | alias of `--color-critical` | See note below. |

Tinted grounds, flattened to literal hex so no runtime color mixing can drift:

| Token | Hex | Derivation |
| --- | --- | --- |
| `--color-tint-accent` | `#2B2017` | `--color-accent` at 12% over `--color-field` |
| `--color-tint-critical` | `#2C1C19` | `--color-critical` at 12% over `--color-field` |
| `--color-tint-quiet` | `#231F1E` | `--color-ink` at 6% over `--color-field` |

Shadow ground, a warm near-black one step below the field so shadows read as
depth rather than as gray haze: `--shadow-ground: 8 5 4` (RGB channels, used
inside `rgb(... / alpha)`).

### Why warm ink

The default dark palette for a developer tool is a cool blue-charcoal around
`#0c0e15` with a bluer panel and a lilac accent. It is the single most
recognisable dark-mode default in the category, and it is rejected. This
palette goes the other way: every neutral sits on one warm hue family, so the
page coheres by construction instead of by tuning, and the amber signal is a
sibling of the ground rather than a sticker on top of it.

### Why one accent

Amber means "signal" on every surface, with no exceptions, so its presence
carries meaning on its own. A second hue would make the first one decorative.
The accent is tonal (54% saturation), never a saturated candy tone.

### Why `--color-destructive` is an alias, not its own color

This tool reads. It has no destructive user action: nothing is deleted, and no
write is issued from the UI. A separate destructive swatch nobody could use
would be a fake role in the sheet, so the token exists for completeness and
points at `--color-critical`. If a destructive action is ever added, it gets its own
value here first.

### Never-pair rules

Ten pairs in the full matrix fall below the 3:1 mark floor. Each becomes a rule
rather than a note, because a rule can be checked:

- An amber fill **always** takes a `--color-field` label. `--color-ink` on `--color-accent` is
  2.58:1 and is forbidden.
- `--color-ink-muted`, `--color-ink-faint`, and `--color-critical` never sit on `--color-accent` or
  `--color-accent-deep`. The only inks those grounds accept are `--color-ink` (on
  `--color-accent-deep`) and `--color-field` (on `--color-accent`).
- `--color-field`, `--color-surface`, and `--color-sunken` are never text colors on one another.
  They are grounds only.

---

## 3. Typography

Three faces. Two are self-hosted from `src/app/fonts/` via `next/font/local`,
80KB total; the third is the platform stack and costs nothing. Attribution and
license: `src/app/fonts/NOTICE.md`. **Technor** and **Tabular** are trademarks
of the Indian Type Foundry; copyright 2016-2021 Indian Type Foundry, all rights
reserved.

| Face | Token | Role |
| --- | --- | --- |
| Technor | `--font-display` | Identity and structure: display, title, heading, and the eyebrow treatment. Nothing else. |
| Platform stack | `--font-text` | Everything read as sentences: body, small, field labels, control text, the abstention prose. |
| Tabular | `--font-data` | Data only: package keys, version strings, timestamps, hop counts, any number in a column. |

Both webfaces were chosen by rendering them against real project content on this
exact palette, not by reputation. Three candidates were compared at 2x; the
specimen settled it. Array was rejected for a stippled glyph edge that degrades
at body size. Tabular was rejected **as a house voice** because it is a true
monospace and mono spread across all non-code text is a costume, and then
adopted for the data role, which is the one place a mono is genuinely correct.

### Why the display face is not the reading face

The first version of this sheet gave Technor everything a human wrote. The
states matrix at `/system`, screenshotted at 2x, showed why that is wrong: a
character display face set at 13px across every label and every paragraph stops
being a signature and becomes the page's only voice. The abstention notice is
the most load-bearing text in this product, and it has to read as a statement of
fact rather than as styling. Technor is therefore confined to identity and
structure, and the reading face is a true neutral.

The neutral is the platform stack rather than a fourth webfont for two reasons:
it costs no bytes on a page that already ships two faces, and it is the one face
a reader's eye is already calibrated to.

### The rule that keeps three faces from arguing

Checkable per element, so it does not drift into "mono because it looks
technical" or "display because it looks designed":

- Tabular appears only where the content is machine-generated: a package key, a
  semver string, an ISO timestamp, a count, a hop number.
- Technor appears only at `--text-display`, `--text-title`, `--text-heading`,
  and in the eyebrow treatment.
- Everything else is `--font-text`.

`h1`, `h2`, and `h3` take the display face from the base layer. **A display step
applied to any other element has to add `font-display` itself**, because
Tailwind has no `--text-*--font-family` sub-property and a size step therefore
cannot carry a face. Three places do: the rail's brand mark, `Eyebrow`, and
`TableHeaderCell`.

### Size steps

| Token | Size / line height | Weight | Tracking | Face |
| --- | --- | --- | --- | --- |
| `--text-display` | 52px / 0.98 | 700 | -0.02em | display |
| `--text-title` | 28px / 1.10 | 500 | -0.01em | display |
| `--text-heading` | 19px / 1.25 | 500 | 0 | display |
| `--text-body` | 15px / 1.50 | 400 | 0 | text |
| `--text-small` | 13px / 1.45 | 400 | 0 | text |
| `--text-eyebrow` | 11px / 1.00 | 500 | 0.16em, uppercase | display |
| `--text-data` | 13px / 1.40 | 400 | 0 | data, `tabular-nums` |
| `--text-data-lg` | 34px / 1.00 | 500 | -0.01em | data, `tabular-nums` |
| `--text-unit` | 11px / 1.00 | 400 | 0 | data |

**Weight ceiling: 700, and 700 is reserved for `--text-display` alone.** Every
other step caps at 500. This is what stops the drift where each new emphasis
reaches one weight higher until the page is uniformly bold.

### Three label treatments, not one

A single label treatment repeated everywhere flattens the hierarchy. Three
exist, each with a placement rule, and no block may use two:

1. **Eyebrow** (`--text-eyebrow`, `--font-display`, `--color-ink-faint`): names a
   region. The status rail's readings, a panel's own identity beside its title, a
   table's column heads. Never stacked directly above a heading as a kicker,
   which is the one placement that turns a label into decoration.
2. **Field label** (`--text-small`, `--color-ink-muted`): names a value or a
   control. Inline to the left of its value in a definition row, or directly
   above the form control it labels. Never above a large heading, where a small
   label over big type reads as a kicker rather than as a label.
3. **Unit suffix** (`--text-unit`, `--font-display` never, `--font-data`,
   `--color-ink-faint`): sits immediately after a number as its unit or qualifier
   ("hops", "of 4", "ms"). Never on its own line.

`--text-unit` and `--text-eyebrow` are both 11px and are still two steps. The
eyebrow's 0.16em tracking and 500 weight are what let a caps region label read at
that size; both are wrong against a number, where the unit has to sit close enough
to belong to the digits. A single 11px step would force one of the two to be wrong,
so the size scale carries both and `UnitSuffix` is the only component that reaches
for the unit one.

---

## 4. Verdict encoding

The abstention model (`src/lib/analysis/abstention.ts`) has three verdicts, and
rendering them is the most load-bearing visual decision in the product: showing
`unknown` as if it were `not_exposed` would tell someone their service is clean
when the tool never looked.

All three live on the **same amber axis** and differ by **value and form**, not
by hue:

| Verdict | Ink | Ground | Mark (7px) |
| --- | --- | --- | --- |
| `exposed` | `--color-accent` | `--color-tint-accent` | solid filled dot |
| `unknown` | `--color-ink-muted` | `--color-tint-quiet` | hatched ring, 1px 45deg hatch |
| `not_exposed` | `--color-ink-faint` | none, bare field | hollow ring, 1px |

Why not red and green: it is hostile to the most common color blindness, and a
green would be the palette's only cool hue, fighting the warm ground. Encoding
by value and form is redundant by design, so the three states survive
greyscale, color blindness, and a projector with the saturation crushed.

Note the direction of emphasis: `exposed` is the loudest, `unknown` is
deliberately more present than `not_exposed`. A clean result is the quietest
thing on the screen, which is the correct ranking for a tool whose worst
failure is a false negative.

Advisory severity is a **separate axis** and never borrows the verdict marks:
`--color-tint-critical` ground, `--color-ink` label, 2px `--color-critical` left rule.

---

## 5. Geometry

### Radii, nesting downward

| Token | Value | Use |
| --- | --- | --- |
| `--radius-shell` | 14px | Outer panel, the console shell |
| `--radius-panel` | 10px | A card inside a shell |
| `--radius-control` | 8px | Button, input, select |
| `--radius-chip` | 6px | Badge, verdict pill |
| `--radius-tick` | 3px | Scrubber handle, small mark |

**Nesting rule:** a child's radius equals its parent's radius minus the padding
between them. A 14px shell with 4px padding holds a 10px panel. Corners stay
concentric instead of a tight radius sitting inside a loose one.

### Spacing

4px base. Steps: 4, 8, 12, 16, 24, 32, 48, 64. Nothing between steps, no
arbitrary values.

Dense profile figures, fixed here so screens cannot each pick their own:
section padding 24px, panel padding 16px, gap between sibling panels 12px, gap
inside a definition row 12px. Two of them are tokens rather than prose, because
a control and a table row have to line up across surfaces built by different
hands:

| Token | Value |
| --- | --- |
| `--h-control` | 32px, every button, input, and select |
| `--h-row` | 36px, every table and list row |

Both sit on the 4px scale, so they also reach for a utility (`h-8`, `h-9`)
without an arbitrary value.

---

## 6. Material and depth

One light source, from above. Every shadow has a positive Y offset. There is no
all-around glow anywhere.

Three materials, and no fourth:

**Field.** Flat `--color-field`, plus two page-level treatments applied once in
`globals.css` and never repeated per component:
- Grain: an inline SVG `feTurbulence` at **4% opacity, static.** Static is
  deliberate: the radar sweep already carries the page's ambient motion, and
  two competing ambient motions fight each other.
- Vignette: `radial-gradient(ellipse at 50% 0%, transparent 40%, rgb(8 5 4 / 0.35) 100%)`.
  Sized so it cannot be pointed at, only felt.

**Raised.** `--color-surface` plus the stack below. Panels, menus, dialogs.

**Recessed.** `--color-sunken` plus an inset stack. The scrubber track, lockfile
wells, input interiors.

### Shadow stack

Layered contact, key, and ambient, tinted with `--shadow-ground` rather than
pure black, and the per-layer opacity **decreases** as elevation rises while
the spread grows. The hairline is the first layer of the stack, not a separate
`border`, so it composites in the right order.

The second layer is a **lit top edge**, and it is what makes the light source
visible rather than merely claimed. Without it the hairline reads as a uniform
border on all four sides, and a raised panel nested on another raised panel
reads as an outlined box instead of a surface above a surface. This was found by
screenshotting the states matrix, not by reading the CSS.

```
--shadow-raised:
  0 0 0 1px #2A2422,
  inset 0 1px 0 rgb(242 237 233 / 0.05),
  0 1px 1px   rgb(8 5 4 / 0.30),
  0 4px 10px -2px rgb(8 5 4 / 0.24);

--shadow-lifted:
  0 0 0 1px #3A322F,
  inset 0 1px 0 rgb(242 237 233 / 0.07),
  0 2px 3px   rgb(8 5 4 / 0.22),
  0 12px 28px -6px  rgb(8 5 4 / 0.18),
  0 24px 56px -12px rgb(8 5 4 / 0.12);

--shadow-sunken:
  inset 0 1px 2px rgb(8 5 4 / 0.45),
  inset 0 0 0 1px rgb(8 5 4 / 0.30);
```

**A material is only legible against the ground it sits on.** Raised belongs on
the field; recessed belongs in a raised panel. Showing the raised material on
`--color-surface` gives it nil ground contrast, and the states matrix's material
section therefore renders the real nesting (field, then a panel on it, then a
tray inside that) rather than three swatches side by side.

### Two component recipes that a utility chain expresses badly

Both live in the component layer of `globals.css` because they are one CSS
property carrying several states, and one property cannot be driven by several
competing utilities:

- **`.tray-interior`**: an input's recessed material plus its rim states. The rim
  is `--color-edge` at rest, `--color-edge-strong` on hover, and
  `--color-critical` under `aria-invalid="true"`. Focus is the app's single
  outline treatment layered on top rather than replacing the rim, so a field that
  is both invalid and focused still shows both facts.
- **`.row-active`**: the row a reader is inspecting, drawn as a 2px accent rule at
  the leading edge over `--color-tint-quiet`. Not an accent ground: the `exposed`
  verdict already owns the accent tint, and one ground carrying both "this row is
  selected" and "this row is exposed" would collapse two independent axes into a
  single encoding.

**No glass anywhere.** No `backdrop-filter`, no translucent panel over content.
This instrument reads real data over a grained ground; a frosted layer would
blur the grain into mud and would put a decorative effect between the reader and
a package version. Recorded as a decision so it is not quietly reintroduced.

---

## 7. Signature element: the propagation trace

**What it is.** An SVG of the real dependency paths out of patient zero, laid
out in concentric hop rings. Patient zero sits at the origin. Hop-1 dependents
land on ring 1, hop-2 on ring 2, and so on. Each drawn polyline is an actual
node sequence returned by `algo.SSpaths`, not a decorative curve. Node radius
encodes the count of services behind that node; edge opacity encodes hop
distance, so depth is legible without a legend.

**Why this and not a chart.** Patient Zero *is* a graph of infection paths over
time. A faux dashboard window, a generic line chart, or a hero illustration
would all be a claim about the product that is not true. The trace is the
answer the tool produces, drawn.

**Placement logic, one rule.** The trace occupies the primary viewport region
of the radar surface and nothing else does. It never repeats, never shrinks
into a card, and never appears on a second surface. Other surfaces carry a
20px **hop-ring glyph** as their identity mark: the rings alone, no paths. Same
geometry at a different scale, which is one signature reused, not two
signatures competing.

**Buildable from this sheet.** It uses `--color-accent`, `--color-accent-deep`, `--color-edge`,
`--color-ink-faint`, the radii, and `--ease-expressive`. It introduces no new token.

**Motion.** A single accent-tinted arc sweeps the rings at 14s per revolution,
inside the ambient-drift band. The paths sit at full opacity from the first
frame; the sweep only brightens what it crosses as it passes.

---

## 8. Motion

Three laws, applied without exception:

1. **Content is visible by default.** No text, control, path, or number has its
   existence gated on an animation completing. Every entrance animates from a
   visible state to a settled one, never from `opacity: 0`.
2. **Motion explains, or it does not ship.** A transition earns its place by
   showing where something came from, what changed, or what is loading.
3. **One light source, one direction, one curve family.**

### Duration ladder

| Token | Value | Use |
| --- | --- | --- |
| `--dur-micro` | 70ms | Press, color change, checkbox |
| `--dur-small` | 130ms | Hover tint, focus ring, badge swap |
| `--dur-std` | 220ms | Panel reveal, tab change, row expand |
| `--dur-hero` | 320ms | The trace redraw when the scrubber commits |
| `--dur-exit` | 175ms | Standard exit, 20% faster than its entrance |
| `--stagger` | 40ms | The one stagger constant. No sequence uses another. |
| `--dur-sweep` | 14s | Ambient radar revolution |

320ms is the ceiling. Nothing in the UI animates longer, the sweep excepted,
because the sweep is atmosphere rather than a response to an action.

### Easing

| Token | Curve | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Entrances, anything arriving |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Exits, anything leaving |
| `--ease-std` | `cubic-bezier(0.4, 0, 0.2, 1)` | Moves and resizes, both ends anchored |
| `--ease-expressive` | `cubic-bezier(0.16, 1, 0.3, 1)` | Reserved for the trace redraw. One place only. |

### Interaction specifics

- **Press:** `scale(0.98)` at `--dur-micro`. Never below 0.95.
- **Hover:** tint only. Buttons do not move, lift, or grow on hover.
- **Focus:** one treatment for the entire app, `outline: 2px solid var(--color-accent)`
  with `outline-offset: 2px`. Never removed, never replaced by a shadow.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, every duration
  collapses to `0.01ms` and the sweep stops. Because content is already visible
  by law 1, nothing disappears when motion is off.

---

## 9. Contrast ledger

Measured with the WCAG 2.1 relative-luminance formula before any component was
written. Every pair the build actually uses, twenty in total, clears **4.5:1**.
Worst used pair: **4.53:1** (`--color-ink-faint` on `--color-surface`).

| Mark | Ground | Ratio |
| --- | --- | --- |
| `--color-ink` | `--color-field` | 16.01 |
| `--color-ink` | `--color-surface` | 14.82 |
| `--color-ink` | `--color-sunken` | 16.65 |
| `--color-ink` | `--color-accent-deep` | 5.06 |
| `--color-ink` | `--color-tint-critical` | 14.03 |
| `--color-ink-muted` | `--color-field` | 7.24 |
| `--color-ink-muted` | `--color-surface` | 6.70 |
| `--color-ink-muted` | `--color-sunken` | 7.53 |
| `--color-ink-muted` | `--color-tint-quiet` | 6.35 |
| `--color-ink-faint` | `--color-field` | 4.90 |
| `--color-ink-faint` | `--color-surface` | 4.53 |
| `--color-ink-faint` | `--color-sunken` | 5.14 |
| `--color-accent` | `--color-field` | 6.20 |
| `--color-accent` | `--color-surface` | 5.74 |
| `--color-accent` | `--color-sunken` | 6.45 |
| `--color-accent` | `--color-tint-accent` | 5.29 |
| `--color-critical` | `--color-field` | 4.95 |
| `--color-critical` | `--color-surface` | 4.58 |
| `--color-critical` | `--color-sunken` | 5.15 |
| `--color-field` | `--color-accent` | 6.20 |

Two roles were adjusted to reach this table rather than being accepted as
drawn. `--color-ink-faint` started at `#726A66` (3.52:1 on field, a fail) and
`--color-critical` at `#B4402E` (3.29:1, a fail). Both were lifted against
`--color-surface`, the brightest of the three grounds, so one value is safe on all
three. `--color-critical` had its saturation eased down as its lightness rose, which
keeps it a tonal red instead of turning it into a candy red. `--color-ink-faint` was
then set by hand rather than taking the solver's output, because the solve had
flattened it to a neutral gray and the warmth is the point.

Marks that carry meaning without carrying text are held to 3:1, and the only
one that matters is the 2px `--color-critical` rule on `--color-tint-critical` at 4.34.

---

## 10. Gate

No screen ships until:

1. Every color, duration, radius, and size in it resolves to a token above.
2. Its states all exist: default, hover, focus-visible, active, disabled,
   loading, empty, error.
3. Its text clears 4.5:1 against its actual ground, per section 9.
4. Nothing is gated on an animation completing.
5. It renders correctly at 2x under `prefers-reduced-motion: reduce`.
