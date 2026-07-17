# bird state art — generation spec

Drop the generated PNGs in THIS folder with these exact filenames.
Perch will pick them up and switch the bird's face by state; any missing
file silently falls back to `logo.png`, so generate in any order.

## the golden rules (read before generating)

1. **Use image-EDIT, not text-to-image.** Attach `logo.png` (repo root) and
   ask the model to *edit* it. This is what keeps him the same bird.
2. **Transparent background.** No backdrop, no card, no drop shadow.
3. **Same scale, same position, same feet anchor** as the original —
   the app swaps these mid-animation; if the body jumps, it flickers.
4. **≥1024×1024 PNG.** We downscale, never upscale.
5. Face-only states (blink, side-eye, focused) must keep the **silhouette
   pixel-identical** — only the face pixels change. Pose states (sleep,
   happy, wave, alert) may change posture, but keep the body mass centered
   in the same spot.

Prompt template (paste with logo.png attached):

> Edit the attached image. Keep the EXACT same character, art style,
> colors, lighting, proportions, scale and position. Transparent
> background, no shadow. Change ONLY the following: <state change>.

## the states, in priority order

| # | file | perch state | the edit |
|---|------|------------|----------|
| 1 | `bird-blink.png` | blinking (everywhere) | close both eyes: replace the round dark eyes with two thin curved closed-eye lines. change NOTHING else — silhouette identical |
| 2 | `bird-sleep.png` | all quiet (doze + breathing) | eyes closed with soft curved lids, head tilted down and tucked slightly toward the chest, body a touch rounder and fluffed, like a genuinely sleeping bird |
| 3 | `bird-alert.png` | a session needs you | eyes wide open and a little bigger, crest feathers standing straight up, beak slightly open mid-chirp — alarmed but cute |
| 4 | `bird-happy.png` | work finished (the hop) | eyes closed in happy upward arcs (^ ^), tiny rosy cheeks, one wing lifted a bit in celebration |
| 5 | `bird-sideeye.png` | parked (ignored 30+ min) | eyes shifted to the side, flat unimpressed expression — the "you've been ignoring this" face. silhouette identical |
| 6 | `bird-worried.png` | error / api retry | slightly furrowed eyes, small frown on the beak, one tiny sweat drop beside the head |
| 7 | `bird-wave.png` | greeting (you hovered) | one wing raised in a friendly little wave, beak open in a happy chirp |
| 8 | `bird-focused.png` | sessions working (optional) | eyes half-lowered in concentration, gaze angled slightly down like he's reading the work. silhouette identical |
| 9 | `bird-hot.png` | 5h limit burning red (optional) | overheated: slightly deeper red flush, two small sweat drops, feathers a bit ruffled |

## what gets wired once files land

- state machine picks the face from the dominant session status
  (attention > error > working > done > quiet)
- random blink every 4–9s using `bird-blink.png` (2 frames = alive)
- moment animations keep playing on top — the perk wiggle runs on the
  alert face, the hop on the happy face, the breath on the sleep face
- 120ms opacity crossfade between faces so swaps feel organic, never snappy
