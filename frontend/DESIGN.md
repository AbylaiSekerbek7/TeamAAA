# CQA design system (Freedom Broker · Контроль качества)

Audience: directors, heads of contact centre, QA specialists and operators of a large broker. The UI must read as a
serious corporate product (in the spirit of Freedom Broker / Tradernet and Microsoft Dynamics 365): calm, dense,
precise, trustworthy. No playful elements, no emoji, no mascots, no gradients-for-decoration, no glassmorphism.

## Brand & tokens (defined in `css/app.css` `:root`; components must use tokens, never raw hex)
- Brand green `--brand #16a34a` (hover `--brand-hover`, strong text `--brand-strong`, tints `--brand-50/100/200`).
- Navy chrome `--navy-900 #161d2c` (sidebar), `--navy-800`, `--navy-700`.
- Neutrals: `--bg` page, `--surface` cards, `--surface-2/3` subtle fills, `--ink` text, `--ink-2` secondary text,
  `--muted`/`--muted-2` captions, `--line`/`--line-2` borders.
- Semantic (always paired with an icon or text, never colour alone): good `--good/-bg/-line`, warning `--mid/...`,
  bad `--bad/...`, info `--info/...`, neutral/N/A `--na/-bg`, internal/hold `--violet/-bg`.
- Type: Inter (fallback Segoe UI). Sizes `--fs-xs 12`, `--fs-sm 13`, `--fs 14` (body), `--fs-md 15`, `--fs-lg 18`,
  `--fs-xl 22` (page title). Never below 11px. Numbers: `font-variant-numeric: tabular-nums`.
- Shape: radius `--radius-sm 6`, `--radius 8` (controls), `--radius-lg 12` (cards). Shadows `--shadow-xs` (cards),
  `--shadow` , `--shadow-lg` (floating). Focus ring `--ring`.
- Spacing scale 4/8/12/16/20/24/32. Page padding 24-28px. Gap between cards `--gap 16px`.

## Layout
- App shell (app.js): dark sidebar with sections and nav items; white appbar with breadcrumbs, role switch and
  user chip; `#job-bar` for evaluation progress; `.view` page container (max 1480px).
- Page pattern: `.page-head` (h1 + one-line description on the left, primary actions on the right) → optional KPI
  row `.kpis > .kpi` (`.kpi-label` with icon, `.kpi-value`, `.kpi-sub`) → filters/toolbar → content cards (`.panel`).
- Tables: `.table-wrap > .table` (uppercase 11px header, 10/14 cell padding, hover row, tabular numbers right-aligned).
- Two-pane detail: list on the left (`.split-list`), detail card on the right (`.split-detail`).

## Components (in app.css)
`.btn` (default/outline), `.btn-primary` (one per area), `.btn-ghost`, `.btn-sm`, `.icon-btn`, `.link`;
`.input`/`select.input`/`textarea.input`, `.field > span` label; `.seg` segmented filter; `.tabs` (underline);
`.tag` (+ `-ok -warn -bad -run -violet`), `.chip` (+ `-good -bad -na -scale`), `.score` (+ `.s-good .s-mid .s-bad`),
`.lang`; `.panel`, `.panel-head`; `.kpi`; `.empty`; `.loading`/`.spin`; `.toast`; `.modal`.

## Icons
`import { icon } from "../icons.js"` → `icon("name", { size: 16 })` returns inline SVG (currentColor).
Available: message, phone, headphones, inbox, scale, clipboard, chart, settings, shield, alert, check, checkCircle,
x, xCircle, minusCircle, plus, upload, download, cloud, play, refresh, sparkles, user, userCheck, search, filter,
clock, arrowLeft, arrowRight, arrowUp, arrowDown, chevronRight, chevronDown, external, trash, edit, copy, file, cpu,
waveform, pause, logIn, logOut, lock, info, gauge, list, layers, globe, bot, zap, square.
Rules: icon + text in buttons where space allows; icon-only buttons must have `title` and `aria-label`.

## Content style
Russian UI copy, short and business-like. Sentence case. Numbers with units («с», «баллов», «%»). Status words:
«Да / Нет / N/A», «Оценён», «На апелляции», «Грубая ошибка». Explain AI results plainly; no hype.

## Accessibility
Contrast ≥ 4.5:1 for text; visible focus (global `:focus-visible`); hit targets ≥ 32px in dense tables; colour is
never the only signal (pair with icon/text); `prefers-reduced-motion` respected globally.
