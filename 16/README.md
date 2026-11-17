November 16, 2026

"Spore"

A colony of spores floating in the dark: tens of thousands of grains (160k on desktops, fewer on phones) in a soft,
slowly folding mass, a waxy golden crust in patches over dark, glossy grains like caviar. Every few seconds the colony
swells in an uneven pulse, a ripe patch of crust pops and lets a few spores drift off, or a bud swells out, pinches off,
wanders round the colony and is taken back in.

Every spore is a particle in a fixed-step GPU simulation. Each step splats the spores into a 64³ density grid (blurred
along each axis) and a finer 128³ packing grid about a grain across; the forces read them back: pressure toward the
density the colony settles at, cohesion and a few springy bonds per spore (which tear when stretched too far), collisions
between neighbouring grains, drag, and a slowly changing curl-noise current that folds the mass into lobes and
overhangs. With two or three colonies, their centres circle each other, drift together until they fuse at the surface
and pull apart again, each spore going back to its own colony, streaked with the others' colours. The spores draw as
camera-facing impostor spheres shaded through the shared pipeline, each lit by one shadow lookup of its own.

Randomizing moves the current to a new place in noise space and reshuffles the look, so the old colony swirls itself
into the new one instead of cutting.

Controls: drag to orbit (freely, over and under the colony: the camera's up turns with it), scroll to zoom, R for a
new colony. While paused, every drag orbits. Hovering stirs the spores under the pointer; clicking a
colony puffs spores out, dragging one pulls a handful out and stretches the mass after them, and holding the right
button (long-press on touch) gathers spores toward the pointer and flings them out on release. L copies a link to the
current view. Focus (slider, or Shift + scroll) moves the focal plane through the colony, from its front to its back. The panel sets the number and size of the spores, the palette, the crust, how translucent the grains are and how much spore detail they show (oval
shapes; up close, a net and a furrow on the crust grains, spines on the dark ones), the studio or microscope look,
the light beam, haze and dust, and the physics: colonies, sorting, speed, pace (how fast the colony lives on its own: its current, pulses, buds and
bursts, while the physics and anything done to it run at speed), flow, turbulence, cohesion, bonds, pressure,
tear, pulses, sporulation and budding. Auto change brings a new colony every 10 seconds;
randomizing, pausing or any interaction starts the count over. After 5 seconds without input the camera floats into
a slow orbit that keeps to the colony's lit side: it circles the light's axis while its angle from the light swings
between 35 and 100 degrees, so it dips past the terminator briefly but never swings round to the back. It eases onto
the bulk of the colony (all of them), slowly zooming between a close fill and a looser view, and a focus puller takes the
focus: every 6-12 seconds it racks to another spot between the colony's front and its
middle, or scans slowly between two, trailing lazily, and when it falls out
of focus it refocuses quickly with a little overshoot. Camera speed sets how fast it moves. Any input hands the camera back.

Notable:

- Depth of field (the pipeline's: a gather while moving, lens samples once still) focuses on the colony's near side;
  the dust draws its own out-of-focus discs with the same lens, after the gather (the pipeline's afterFocus hook).

- The simulation runs on a fixed step from the seed, so a view link (L) replays it to the same point: the link holds
  the query the page opened with plus every randomize and panel change since, and the page fast-forwards to the step
  behind the loading pill. Pointer input, the camera and spin over time, and changes made while paused aren't recorded.
  The colony comes back in the same shape and place; individual grains land a little differently, as the GPU
  simulation varies slightly from run to run.
- Panel changes ease per simulation step, and on wall-clock time while paused, so they still show.
- Motion vectors come from each spore's position at the start of the frame, so AO/GI reprojection follows the grains;
  the motion blur slider scales the same move by its shutter.
- The air is ray-marched at half resolution against the pipeline's key-light shadow map: a shaft along the key and a
  thin haze, so the colony's real shape casts shadow volumes through the beam, and looking up toward the light from
  below gives god rays (plus screen-space streaks toward the light while it's in or near view).
- Simplex noise with its analytic gradient (webgl-noise, Ian McEwan / Stefan Gustavson, MIT) gives the curl in three
  noise lookups instead of eighteen finite differences.
