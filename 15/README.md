November 15, 2026

"Mirage"

A holographic trading card (or a clean glass plate) dashing down a retro synthwave tunnel to the music, swaying to show
its foil and hologram, and flipping every so often to reveal a new one. The hologram inside is a frozen 3D scene,
replayed the way a white-light dichromated gelatin (DCG) reflection hologram replays it: a spray of chunky gears (day
11's builders), one of day 2's bursts halfway through (its shell sphere or bronze torus), or one of the light scenes:
Suzanne's head, a cluster of crystals, one big gear with its pinions, chess pieces on a board, a knot, an atom, a
Rubik's cube mid-turn, Saturn, and a pyramid with its capstone floating above it.

The holographic shader is spite's own (a standalone three.js study, brought into the pipeline here).

Controls: drag to spin the card, scroll to zoom, Space to pause, F for fullscreen (which hides the UI), R for a new card, M
for sound, C to copy a link to the exact moment (it replays paused). The panel sets the card, scene and seed, the hologram's colour, bandwidth, swelling, viewing zone and
dispersion, the background rings (and the solid tracks under them), the glass and how much of the tunnel it reflects,
and the motion. Auto change flips to a new card every 8 bars of the music (without it, every 10 seconds), a trading card
or a glass plate at even odds, never three of one in a row.

Notable:

- The scene is frozen, so it is recorded once: merged into one mesh, lit per vertex on the GPU from a few hundred
  directions, and given a soft key-light shadow map. Every frame it is drawn through the glass from the camera into a
  record buffer and eight bands of wavelength (six on phones), each band one depth-tested draw into its own colour
  channel.
- Replay is physical: Bragg reflection picks the colour from the lights' and viewer's angles, each band is sheared about
  the plate (dispersion grows with distance from it, smeared along the light's direction), the gelatin's swelling shifts
  it toward orange-red in patches, and the image fades out past the viewing zone. Dark parts of the recording still
  occlude what is behind them.
- The next card is prepared in the background, a slice a frame (a gear or a piece a frame, the merge in chunks, the bake
  eight directions a frame, the fingerprints twenty a frame), then swapped in as the card passes edge-on in its flip, so
  the frame rate doesn't hitch. Day 2's bursts use its shapes at 60% of their tessellation, without the smallest chips.
  The card winds back a little before it spins, as if gathering momentum.
- The trading card has prismatic foil, glitter and a white stock edge; the glass plate has green edges. Both carry real
  fingerprint scans as grease (after genuary-2026 day 6) and fine wear, and catch the glint of a lamp just above the
  camera.
- The tunnel is one tube, bent in its vertex shader: straight at the card, it winds away by how far the path ahead has
  turned, and it slowly rolls. Its wall is one of seven neon styles, from plainest to busiest: rings, laser lanes with
  beams on the beat, a synthwave grid, retro suns, a hexagonal hall with embers, tiles, Memphis shapes. A new style comes
  in from ahead tile by tile on a lattice all styles share (24 lanes round, a lane's width along). With the music the
  plainest plays the opening 12 s, then the style follows how hectic the song is (batec's curve, spread over the song's
  own range), holding each for at least 4 bars, and as it gets more hectic the light-speed streaks and then the dot
  spiral layer on top; without it, a new style every 140 m.
- Motion blur: the tunnel smears its lines across the tube in closed form as they stream past (the shape styles average
  just their pattern over a few taps), and the card is blurred by its own turning, traced back onto its plane.
- The glass and foil reflect the tunnel as it is: each pixel traces its reflection to the bent tube and draws the wall
  there, blurred by roughness and distance and streaming like the tunnel itself (lifted on the dark glass, so its dim
  fill and lit tiles still show). Each style's ambient light is baked once.
- Each card is its own program, both compiled at load. Loop bounds are uniforms so D3D can't unroll the marches and
  light loops (as one program it compiled for over ten seconds and lost the WebGL context on Windows).
- The soundtrack (`sound/tunnel.mp3`) starts once the page renders smoothly (no shaders left to compile), loops while
  the page plays and pauses with it. Its clock is what the speakers play (corrected for the output latency).
- The scene moves to it, from a beat map made offline with batec (`sound/tunnel.batec.json`, runtime vendored in
  `third_party/batec/`): the tunnel's animations run on the song's beat (the tiles' chase steps on each beat, every
  fourth ring flashes as it passes the card, the grid's scan goes round once a bar, panels and dots pulse, hats flicker
  the embers and dots), kicks flash it, light a scatter of its cells and send rings of light down it, and its travel
  locks to the tempo (the speed snaps to a whole number of rings a beat, eased into phase so a ring passes the card on
  every beat). The card glides freely, its only move a barrel roll when a new section of the song begins, and hats glint
  its foil. With music, auto change counts the song's bars ("Change every (bars, with music)", 8 by default): the card
  spins up a bar before a phrase and the new one lands on its first downbeat; the drop spins one in too. The glide's
  pace follows the song's mood, its valence times its energy (quiet or sad slower, loud and happy faster). Without music
  the tunnel keeps its own pulses.
