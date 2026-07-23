# Make a Perch mascot — the complete generation spec

You are generating the art for a **new Perch mascot**: the little creature
that lives in the Perch HUD and reacts to what your coding agents are doing.
This file tells you **every image to generate**, the **exact filename** each
must have, and **what the creature is doing** in each one.

Perch ships with a bird. This is how you replace it with anything you want —
a cat, a robot, a slime, a tiny dragon, a ghost, a potato with eyes. The
*states* below are fixed (they map to real app events); the *character* is
entirely yours.

---

## How it works (read this first)

- A mascot is **one folder** of PNGs: `assets/mascots/<your-mascot-name>/`
  (e.g. `assets/mascots/cat/`). Create that folder and put every PNG below
  inside it.
- Perch picks the mascot in **Settings → mascot** (the gear icon). Your
  folder shows up there automatically once it contains a `logo.png`.
- **Missing files never crash and never blank the HUD.** Any state you don't
  generate falls back to `logo.png` (the neutral face). So you can generate
  in **any order** and ship a partial pack — the mascot just "levels up" as
  you add more frames. Start with `logo.png` + the 8 core faces; add the
  rest whenever.

### The 4 golden rules (structure — go wild *inside* them)

1. **Same character in every file.** Generate `logo.png` first (the neutral
   resting face). For every other file, **image-EDIT that logo** — attach it
   and ask for *only* the described change. This keeps it recognizably the
   SAME creature across frames. Do not text-to-image each one from scratch;
   it'll drift into 20 different characters.
2. **Transparent background. Always.** No backdrop, no card, no ground
   shadow, no floor. PNG with real alpha. The mascot sits on the app's own
   surface — any background will look like a bug.
3. **Same scale, same center of body-mass** as `logo.png` in every frame.
   Frames get swapped mid-animation; if the body jumps or resizes between
   frames it reads as flicker, not life. Keep the body anchored; move the
   *expression and props*, not the whole creature.
4. **Square, ≥1024×1024, chunky, readable.** It renders as small as **38px**
   inside a ring, so: bold shapes, thick props, big clear eyes. Keep props
   CLOSE to the body — anything that drifts far from center gets cropped by
   the ring and fine detail vanishes. We downscale, never upscale.

### Prompt template (paste with `logo.png` attached)

> Edit the attached image. Keep the EXACT same character, art style, colors,
> lighting, proportions, scale, and position of the body. Transparent
> background, no shadow. Change ONLY the following: **\<the state's edit\>**.

---

## The files to generate

Filenames are **exact** (lowercase, `.png`). Drop them all in your
`assets/mascots/<name>/` folder.

### 1 · the neutral face — GENERATE THIS FIRST

| file | what it is |
|------|-----------|
| `logo.png` | The mascot at **rest**: relaxed, friendly, looking at the viewer, mouth/beak closed, neutral-happy. This is the resting face AND the app's header logo AND the fallback for every missing state. It must read clearly at 24px. Everything else is an edit of this. |

*(You may name it `neutral.png` instead — Perch accepts either.)*

### 2 · the 8 core faces (do these next — they cover the common states)

Each maps to something your coding agents actually do.

| file | app state (when it shows) | the edit |
|------|--------------------------|----------|
| `blink.png` | idle blink, every few seconds | Eyes CLOSED (soft, content curves). **Change nothing else at all** — it flashes for ~150ms against the neutral face, so any other change would blip like a glitch. Eyes only. |
| `alert.png` | **a session needs your permission** (the big one) | Full cartoon ALARM: eyes huge, expression shocked/urgent, mouth open mid-call, a bold exclamation mark floating beside the head, tiny shock lines. This one must grab your eye across the room. |
| `happy.png` | a task just finished (the celebration) | Party mode: joyful squeezed-shut happy eyes, big grin, one arm/wing/limb flung up mid-celebration, a burst of confetti. |
| `focused.png` | sessions are working | Concentrating: tiny reading glasses or a visor, eyes half-lowered looking down at work, maybe a pencil/tool tucked nearby. Calm, busy, in-the-zone. |
| `sideeye.png` | a needs-you was ignored 30+ min ("parked") | Deadpan, unimpressed side-eye — one brow raised, holding a tiny coffee/drink mid-sip. The "I've been waiting" look. |
| `worried.png` | an error / API retry | Anxiety comedy: one eye a nervous spiral or wide-and-trembling, sweat drops, fidgeting. Worried but cute, not scary. |
| `sleep.png` | everything's quiet, nothing running | Fully asleep: eyes shut, a little nightcap or drooping posture, one or two floating Z's, maybe a drool bubble. Cozy. |
| `hot.png` | the 5-hour usage limit is burning near its cap | Overheating: flushed red, steam wisps off the head, fanning itself, sweat drops. "Running hot." |

### 3 · the extended cast (more personality — optional but great)

| file | app state | the edit |
|------|-----------|----------|
| `wave.png` | you hovered over the mascot (it greets you) | Max charm: one limb raised in a big friendly wave, leaning toward the viewer, a wink, a sparkle. |
| `grabbed.png` | while you DRAG the HUD pill around | Held like a scruffed kitten: body dangling limp and slightly stretched, limbs hanging, resigned dot-eyes, one sweat drop. Total surrender. |
| `hatch.png` | app startup (~1.5s hello on boot) | Just-born: emerging from a cracked egg / box / portal that fits the character, wide-eyed and delighted, a shell/lid piece on the head, a sparkle. |
| `knocked.png` | the usage limit fully BLOCKED you | Comedic KO: knocked out, X-eyes, tongue out, little stars orbiting the head, one limb twitching up. |
| `crown.png` | EVERY session done, zero waiting (peak state) | Absolute monarch: a golden crown, tiny cape, chest puffed, smug half-lidded eyes. Maximum self-satisfaction. |
| `launch.png` | you clicked a red row to jump to its terminal | Takeoff: goggles/helmet on, a scarf trailing, leaned into a superhero launch pose, two speed lines behind. |
| `cursing.png` | you PESTERED it (spam-hover, or shake it while dragging) | Losing it: furious slanted brows, `><` rage eyes, mouth open mid-rant, red flush, steam puff, a shaking fist, and a chunky comic speech bubble close to the head with grawlix: `@#$%&!` |
| `offline.png` | offline / local-estimate mode | Lost explorer: a little antenna hat with a "no signal" X above it, squinting at a folded paper map held in both hands. |

### 4 · the sprite tier (loop pairs — real animation from one extra frame)

Each of these is a **second frame** of a state above, alternated rapidly to
animate it. Keep everything identical to the parent frame **except the one
named moving part**.

| file | pairs with | the edit |
|------|-----------|----------|
| `happy2.png` | `happy.png` | Identical to `happy`, but the flung limb DOWN and the confetti fallen lower. Alternated ~90ms = real flapping/cheering. |
| `hot2.png` | `hot.png` | Identical to `hot`, but the fan at the opposite point of its swing. Alternated ~180ms = frantic fanning. |
| `sideeye2.png` | `sideeye.png` | Identical to `sideeye`, but the drink RAISED to the mouth mid-sip. Swapped in every few seconds = it periodically sips while judging you. |
| `drowsy.png` | bridges into/out of `sleep.png` | Half-asleep: eyes half-lidded, head starting to droop, one Z. Shown briefly when falling asleep AND waking up, so there's no hard snap to unconscious. |

---

## Minimum viable mascot

If you only do a few: **`logo.png` + `alert.png` + `happy.png` + `sleep.png`**
already covers the moments you'll see most (needs-you, finished, quiet).
Everything else falls back to `logo.png` gracefully. Add more anytime.

## When you're done

1. Put every PNG in `assets/mascots/<your-name>/`.
2. Open Perch → gear (⚙) → **mascot** → click your mascot. It swaps live.
3. Save. Perch remembers it across restarts.

That's it. The state machine, animations, crossfades, and event wiring are
already built — you're only supplying the art, and Perch handles the rest.
