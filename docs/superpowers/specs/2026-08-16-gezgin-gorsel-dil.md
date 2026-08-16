# Keşif Gezgini yeniden tasarımı — onaylı kararlar (16 Ağu, Burak)

Owner rejected the first shipped UI ("table + filters = todo app / AI slop").
Approved replacement, iterated over 5 mock rounds. Binding decisions:

## Information architecture — 3 levels
1. **Giriş (route `#/`)** — fleet view: every store project as a health card.
   Mock: `mock-giris-v5.html` (verbatim-approved layout, B palette).
2. **Proje raporu (route `#/proje/<id>`)** — the "diagnosis report":
   hero = health ring (N/M not temiz) + ONE verdict sentence (serif) +
   segmented verdict band + runs sparkline; below, "Bakmanı isteyen N vaka"
   case cards; then quiet rows (clean notes count, unclassified-candidate count).
3. **Not sicili (route `#/finding/<id>`)** — existing immutable-ledger detail
   screen, restyled to the same language.

## Skin — "B: Grafit & Menekşe"
bg #17181D · card #1D1F26 · ink #E9E9EF · prose #D6D7E0 · dim #9A9CAC ·
faint #6D6F80 · line #282A34 · track #262832 · accent (menekşe) #9D9BF5 /
lighter #B9B7FA · clean-green #58C08A · attention-amber #F5C044 (dark text
#231A05 on it) · warm-drift #E0713A.
Fonts already vendored (core/web/fonts): Source Serif 4 = prose/diagnosis/hero
sentence; Inter = chrome; JetBrains Mono = paths, SHAs, dates, numbers.

## Visual dictionary (replaces text wherever possible)
- **Amber is the ONLY attention color**, used solely for "user action waiting"
  (ONAY BEKLİYOR chip, pending counts, ring of a project that needs action).
  Chip: amber bg, dark text, small pulsing dot (disabled under reduced-motion).
- Suspicion score → small meter bar (violet→#E0713A gradient fill) + tabular number.
- Anchors → mono chips with a health dot: green=intact, #E0713A=moved/lost, gray=anchorless ("çapasız — dosya izlenemiyor").
- Verdict distribution → segmented horizontal band (green/violet/amber/gray) + tiny legend, never counter boxes.
- Run history → mini polyline sparkline, last point emphasized.
- Case card: 3px left stripe in verdict color.
- Clean notes → row of small green squares.
- Sleeping project: faded ring but 100% — "unused ≠ decayed" made visual.

## Diagnosis sentences (the core anti-slop change)
Every case card carries ONE plain-Turkish sentence produced RULE-BASED (no LLM)
from (finding, live verdict, anchors). Serif, may embed one <b>-accent phrase.
Never show raw frontmatter (`--- name: ...`). Humanize the note title
(frontmatter `name:` field or filename, not the content dump).

## Navigation copy
Topbar: CONTEXT POLICE (violet eyebrow) · nav "Projeler / Koşumlar" on home;
report page belongs to a project. UI copy Turkish, identifiers English.
