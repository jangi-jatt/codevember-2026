November 16, 2026

"Spore"

A colony of spores floating in a shaft of light: tens of thousands of grains (160k on desktops, fewer on phones) in a
soft, slowly folding mass, a waxy golden crust in patches over dark, glossy grains like caviar. It lives on its own:
every few seconds it swells in an uneven pulse, a ripe patch of crust pops and lets a few spores drift off, or a bud
swells out, pinches off, wanders round the colony and is taken back in. Some colonies are calm, rounded blobs; wilder
ones stretch out into arms; with two or three, they drift apart and back together.

Controls: hover to stir the spores, click a colony to puff spores out of it, drag one to stretch it, hold the right
button (long-press on touch) to gather spores and release to fling them, drag around it to orbit (freely, over and
under), scroll to zoom, Shift + scroll to move the focus through it, R for a new colony, L to copy a link to the view.
While paused, every drag orbits. Or leave it be: auto change brings a new colony every 10 seconds once the last change
has settled, and after 5 seconds without input the camera takes over. The panel sets the spores (count, size, palette,
crust, translucency, detail), the look (halo, light beam, haze, dust, depth of field, focus,
motion blur, spin, camera speed) and the physics (wildness, colonies, sorting, speed, pace, flow, turbulence, scale,
cohesion, bonds, pressure, drag, tear, collisions, pulses, sporulation, budding, and how hard hovering and puffing hit).

Notable:

- Every spore is a particle in a fixed-step GPU simulation. Each step splats the spores into a 64³ density grid (blurred
  along each axis) and a finer 128³ packing grid about a grain across, and the forces read them back: pressure toward
  the density the colony settles at, cohesion, a few springy bonds per spore that tear when stretched too far,
  collisions between neighbouring grains, drag, and a slowly changing curl-noise current that folds the mass into lobes
  and overhangs. Simplex noise with its analytic gradient (webgl-noise, Ian McEwan / Stefan Gustavson, MIT) gives the
  curl in three noise lookups instead of eighteen finite differences.
- Speed runs the physics and anything done to the colony; Pace runs its own life (the current, pulses, buds, bursts,
  colonies circling), so it can live slowly and still react at full speed. Drawn positions sit between the last two
  steps, so a slow simulation still moves every frame.
- Wildness sets the physics in one go, from a calm, rounded blob to a wild mass of arms (a strong, coarse current against
  weak cohesion and pressure, held by tough bonds). Randomizing alternates calmer and wilder colonies, most near the
  middle and few at the extremes, and several colonies always go back to one before splitting again.
- Nothing jumps. A new colony's colours, crust and grain size reach each spore on its own schedule (a start shared
  loosely by its clump, its own offset and pace), so the change spreads through the mass in patches. The physics and
  the current follow gentle springs, slower the bigger the change (up to about 15 s for the most extreme). A change in
  the number of colonies draws them together first and spreads them out again, each spore taking its new colony's
  colour in its own time.
- The spores are camera-facing impostor spheres (slightly oval, with a net, furrow or spines up close) shaded through
  the shared pipeline. Each grain's light is looked up once a frame in its own pass: the key at its lit side, and light
  scattered through the mass to it, from the thickness between it and the first grain the light meets, so thin lobes
  and edges glow when backlit. Motion vectors follow the grains, so AO/GI reprojection and motion blur do too.
- The air is ray-marched at half resolution against the key light's shadow map: a shaft along the key and a thin haze,
  so the colony's real shape casts shadow volumes through the beam, and looking up toward the light from below gives
  god rays (plus screen-space streaks toward the light while it's in or near view). Dust specks glint in the beam.
- Depth of field focuses on the colony's near side: a gather while anything moves, lens samples once still (the last
  live frame held and cross-faded into them, so settling doesn't shake). The dust draws its own out-of-focus discs with
  the same lens, after the blur.
- The idle camera floats round the colony's lit side: it circles the light's axis while its angle from the light swings
  between 35 and 100 degrees, so it dips past the terminator briefly but never swings round to the back. It frames the
  bulk of the colony (all of them, wider for wilder ones), slowly zooming between a close fill and a looser view, while
  a focus puller racks or scans between the front and the middle, trailing lazily and refocusing quickly, with a little
  overshoot, when it falls out of focus. The orbit and dragging are gimbal-free.
- Settings that only change the picture apply while paused too.
- The simulation runs on a fixed step from the seed, so a view link (L) replays it to the same point: the link holds
  the query the page opened with plus every randomize and panel change since, and the page fast-forwards to the step
  behind the loading pill. Pointer input, the camera and spin over time, and changes made while paused aren't recorded;
  individual grains land a little differently, as the GPU simulation varies slightly from run to run.
- Sound: a bed of `sound/sound.mp3` time-stretched 10x at its own pitch into a slow drone (overlapping, jittered grains
  creeping through the track at a tenth of real time), and the colony's own sounds synthesized from filtered noise and
  sines and placed in 3D (HRTF) where they happen, with the listener at the camera: the swarm seethes constantly, swells
  breathe a low rush, bursts crackle, buds gulp, hovering over it rustles, a tap lands with a low thump, grabbing a
  colony comes unstuck with a smaller one and stretching it creaks, colonies tear apart and fuse back with a wet merge, gathering builds and flings whoosh, and a transformation groans, a deep, unpitched rush swelling and
  sinking over tumbling ticks. They pass through a soft saturation and a low-pass, so they come out low, rough and muffled. Faint clicks and clacks come
  from the room behind the listener, mostly as reverb. M or the button turns it on and off; pausing pauses it.
