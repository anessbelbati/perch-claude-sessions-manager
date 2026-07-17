# bird state art — generation spec (crazy edition)

Drop generated PNGs in THIS folder with these exact filenames.
Perch picks them up per state; any missing file falls back to `logo.png`,
so generate in any order — he levels up incrementally.

## the golden rules (non-negotiable, even going crazy)

1. **Use image-EDIT, not text-to-image.** Attach `logo.png` (repo root) and
   ask the model to *edit* it. This keeps him the SAME bird.
2. **Transparent background.** No backdrop, no card, no ground shadow.
3. **Same scale, same center of body mass** as the original — these swap
   mid-animation; if the body jumps between frames, he flickers.
4. **≥1024×1024 PNG.** We downscale, never upscale.
5. Face-only states (blink, sideeye, focused) keep the **silhouette
   pixel-identical**. Pose/prop states can go wild with posture and props,
   but props must stay CLOSE to the body (they render at 38px — a prop
   drifting far from him gets cropped by the ring).
6. Props small and bold — at 38px a subtle detail vanishes. Chunky > fine.

Prompt template (paste with logo.png attached):

> Edit the attached image. Keep the EXACT same character, art style,
> colors, lighting, proportions, scale and position of the body. Flat
> cute vector-style like the original. Transparent background, no shadow.
> Change ONLY the following: <state change>.

## core cast (wire the moment they land)

| # | file | perch state | the edit |
|---|------|------------|----------|
| 1 | `bird-blink.png` | blinking, everywhere | both eyes closed as thin curved lines. NOTHING else — silhouette identical |
| 2 | `bird-sleep.png` | all quiet (doze + breath) | fast asleep: droopy nightcap in soft purple, eyes closed with soft lids, head tucked toward chest, body fluffed rounder, one tiny drool bubble at the beak |
| 3 | `bird-alert.png` | a session needs you | FULL ALARM: eyes huge, crest feathers exploded straight up, beak wide open mid-screech, two tiny motion lines beside the head |
| 4 | `bird-happy.png` | work finished (the hop) | party mode: tiny golden party hat tilted on the head, eyes closed in happy ^ ^ arcs, rosy cheeks, 4-5 confetti pieces floating right around him |
| 5 | `bird-sideeye.png` | parked (ignored 30+ min) | dead-flat unimpressed side-eye while holding a tiny paper coffee cup in one wing, mid-sip. the meme. silhouette otherwise identical |
| 6 | `bird-worried.png` | error / api retry | dizzy: spiral swirl eyes, two sweat drops, three small loose feathers popping off the top of his head |
| 7 | `bird-wave.png` | greeting (you hovered) | one wing raised high in a big friendly wave, beak open in a happy chirp, one tiny sparkle beside the wing |
| 8 | `bird-focused.png` | sessions working | tiny round reading glasses perched on the beak, eyes half-lowered looking down like he's reviewing the work. silhouette identical |
| 9 | `bird-hot.png` | 5h limit burning red | COOKING: deeper red flush, steam wisps rising off his head, a tiny thermometer held in the beak, slightly ruffled feathers |

## extended cast (the crazy tier — nobody's widget has these)

| # | file | perch state | the edit |
|---|------|------------|----------|
| 10 | `bird-grabbed.png` | while you DRAG the pill | held by the scruff like a kitten: body dangling limp and stretched slightly downward, wings hanging, blank resigned stare straight ahead |
| 11 | `bird-hatch.png` | app boot (~1.5s hello) | bottom half still inside a cracked white egg shell, peeking out wide-eyed, one bit of shell resting on his head |
| 12 | `bird-knocked.png` | usage limit BLOCKED / exceeded | knocked out flat: lying tilted, X or spiral eyes, tongue slightly out, three tiny stars circling above his head |
| 13 | `bird-offline.png` | offline / local-estimate mode | little explorer: tiny antenna hat with a red no-signal X above it, squinting at a tiny folded paper map held in his wings |
| 14 | `bird-crown.png` | EVERY session done, zero waiting | tiny golden crown, chest puffed out, the smuggest proud face physically possible |

## sprite tier (optional, unlocks real flapping)

| # | file | pairs with | the edit |
|---|------|-----------|----------|
| 15 | `bird-happy2.png` | `bird-happy.png` | identical to bird-happy but the lifted wing in the DOWN position — we alternate the two at ~90ms during the hop = actual flapping |

## what gets wired once files land

- face state machine from dominant status (blocked > attention > error >
  working > done-all > quiet), with 120ms opacity crossfades
- random blink every 4–9s on whatever face is showing (blink frame overlays)
- `bird-grabbed` swaps in the instant a drag starts, back on drop —
  the drag-fold already exists, the bird just needs to look the part
- `bird-hatch` plays once on boot, then crossfades to the live state
- moment animations layer on top: perk wiggle on alert, hop (with
  flap frames if present) on happy, breath on sleep, squash on grabbed-drop
