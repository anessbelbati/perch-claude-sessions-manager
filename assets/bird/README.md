# bird state art — generation spec (maximalist edition)

Drop generated PNGs in THIS folder with these exact filenames.
Perch picks them up per state; any missing file falls back to `logo.png`,
so generate in any order — he levels up incrementally.

## the golden rules (structural, not stylistic — the model can go wild inside them)

1. **Use image-EDIT, not text-to-image.** Attach `logo.png` (repo root) and
   ask the model to *edit* it. This keeps him the SAME bird.
2. **Transparent background.** No backdrop, no card, no ground shadow.
3. **Same scale, same center of body mass** as the original — frames swap
   mid-animation; a body that shifts between frames reads as flicker.
4. **≥1024×1024 PNG.** We downscale, never upscale.
5. Props stay CLOSE to the body and CHUNKY — he renders at 38px inside a
   ring; far-drifting props get cropped, fine detail vanishes. Bold shapes.
6. `bird-blink` alone must keep everything except the eyes pixel-identical:
   it flashes for ~150ms against the neutral frame, so any extra element
   would blip in and out like a render bug. The eyes themselves can be
   gorgeous — that's the one canvas it gets.

Prompt template (paste with logo.png attached):

> Edit the attached image. Keep the EXACT same character, art style,
> colors, lighting, proportions, scale and position of the body. Flat
> cute vector-style like the original. Transparent background, no shadow.
> Change ONLY the following: <state change>.

## core cast

| # | file | perch state | the edit |
|---|------|------------|----------|
| 1 | `bird-blink.png` | blinking, everywhere | eyes closed as two soft downward-curved lines with a tiny lash-flick at each outer corner — serene, contented, the cutest possible mid-blink. NOTHING else changes (see rule 6) |
| 2 | `bird-sleep.png` | all quiet (doze + breath) | full bedtime: droopy pastel-purple nightcap with a pom-pom hanging over one eye, eyes closed with soft lids, head sunk into fluffed-up chest feathers, a tiny blanket wrapped around his lower body, one small drool bubble, two little floating Z's just above the nightcap |
| 3 | `bird-alert.png` | a session needs you | FULL CARTOON ALARM: eyes enormous with tiny white shock-highlights, crest feathers blasted upward like an explosion, beak wide open mid-SCREECH, short shockwave lines radiating from his head, a small bold red exclamation mark floating beside him |
| 4 | `bird-happy.png` | work finished (the hop) | party animal: golden party hat tilted rakishly, eyes closed in blissful ^ ^ arcs, big rosy cheeks, one wing flung up mid-throw with confetti and a curl of streamer bursting from it |
| 5 | `bird-sideeye.png` | parked (ignored 30+ min) | the meme itself: dead-flat unimpressed side-eye with one brow-feather raised, holding a tiny paper coffee cup in one wing mid-sip, a single steam curl rising from the cup. body/silhouette otherwise identical |
| 6 | `bird-worried.png` | error / api retry | anxiety comedy: ONE eye a spiral, the other wide and trembling, nervously nibbling his own wingtip, two sweat drops, three loose feathers popping off the top of his head |
| 7 | `bird-wave.png` | greeting (you hovered) | maximum charm: one wing raised high in a big friendly wave, leaning slightly toward the viewer, one eye winking, beak open in a happy chirp, a single sparkle beside the raised wing |
| 8 | `bird-focused.png` | sessions working | tiny round reading glasses on the beak, eyes half-lowered in deep concentration looking down, a small yellow pencil tucked behind his head-feathers like a carpenter |
| 9 | `bird-hot.png` | 5h limit burning red | OVERCLOCKED: deeper red flush across the whole body, steam wisps rising off his head, frantically fanning himself with a tiny paper hand-fan in one wing, two flying sweat drops |

## extended cast (the crazy tier)

| # | file | perch state | the edit |
|---|------|------------|----------|
| 10 | `bird-grabbed.png` | while you DRAG the pill | held by the scruff like a kitten: body dangling limp and slightly stretched, wings hanging straight down, little feet with curled toes, eyes as two flat resigned dots, one small sweat drop — total surrender |
| 11 | `bird-hatch.png` | app boot (~1.5s hello) | first day on earth: bottom half inside a cracked white egg shell, peeking out wide-eyed and delighted, one piece of shell balanced on his head like a beret, a tiny sparkle beside him |
| 12 | `bird-knocked.png` | usage limit BLOCKED | full KO: lying tilted, X-crossed eyes, tongue lolling out, three tiny stars orbiting above his head, one leg sticking straight up mid-twitch |
| 13 | `bird-offline.png` | offline / local-estimate mode | lost explorer: tiny antenna hat with a bold red no-signal X above it, squinting hard at a small folded paper map held in both wings, one brow-feather furrowed |
| 14 | `bird-crown.png` | EVERY session done, zero waiting | absolute monarch: golden crown, tiny royal-purple cape draped over his shoulders, chest puffed to the limit, eyes smugly half-lidded, the most self-satisfied face physically possible |
| 15 | `bird-launch.png` | red-dot click (jump to terminal) | takeoff: tiny aviator goggles strapped on, a little red scarf trailing behind, body leaned forward into a superhero launch pose, two speed lines behind him |

## sprite tier (frame pairs + transitions — real animation, cheaply)

Two rules make this tier work: **gradual emotions get an in-between frame,
sudden ones get a hard cut** (getting grabbed/alarmed/KO'd is funnier as a
snap), and **a loop pair = one extra frame of an existing state** that we
alternate — infinite animation from a single image. Each pair frame must
keep everything identical to its parent except the named moving part.

| # | file | pairs with | the edit |
|---|------|-----------|----------|
| 16 | `bird-happy2.png` | `bird-happy.png` | identical to bird-happy but the flung wing in the DOWN position and the confetti fallen lower — alternated at ~90ms during the hop = actual flapping with confetti physics |
| 17 | `bird-drowsy.png` | transition into/out of `bird-sleep` | halfway asleep: eyes half-lidded, head starting to droop to one side, nightcap sitting crooked, one tiny Z. shown ~250ms in BOTH directions (dozing off and waking up) |
| 18 | `bird-sideeye2.png` | `bird-sideeye.png` | identical but the coffee cup RAISED to the beak mid-sip, eyes still dead flat — swapped in for ~400ms every few seconds, so the parked bird periodically SIPS while judging you |
| 19 | `bird-hot2.png` | `bird-hot.png` | identical but the paper fan at the opposite angle of its arc — alternated at ~180ms = frantic real-time fanning while he cooks |

## what gets wired once files land

- face state machine from dominant status (blocked > attention > error >
  working > done-all > quiet), 120ms opacity crossfades between faces
- random blink every 4–9s overlaid on whatever face is showing
- `bird-grabbed` swaps in the instant a drag starts, back on drop
- `bird-hatch` plays once on boot, then crossfades to the live state
- `bird-launch` flashes ~400ms when you click the red count, right as
  Perch throws you into the terminal
- moment animations layer on top: perk wiggle on alert, hop (with flap
  frames if present) on happy, breath on sleep, squash on grabbed-drop
- transitions: `bird-drowsy` bridges into/out of sleep (~250ms each way);
  sudden states (grabbed, alert, knocked, launch) stay HARD CUTS on purpose
- loop pairs: sip every few seconds on parked, frantic fan alternation on
  hot, flap alternation during the hop — one extra frame each, endless life
