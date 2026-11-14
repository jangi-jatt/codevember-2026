November 14, 2026

"Tension"

Surface tension in zero gravity: an object floating in a spacecraft cabin, wrapped in a coat of water that clings to
it, ripples when tapped, rings as a whole, and pulls out into tendrils that neck and snap into drops which drift back
and merge.

The water is ray traced in a composite pass of the shared pipeline: a signed distance field of the body (baked at 96³ by
`tools/bake.mjs`) grown into a coat whose thickness is a simulated wave height on the body's surface mesh (`waves.js`,
splatted into a 3D texture on the GPU from a map a worker builds), tap ripple trains, and drops and tendrils as
ellipsoid blobs. Rays refract in and out with Fresnel and total internal reflection, and shade the body from its field.
The cabin is a 360° panorama, defocused (`backdrop.js`) and lifted into the environment that lights the body.

The coat pools unevenly and lags the body: it drifts on a soft spring, and when pushed the water piles up on the
trailing side and swings back. The background tumbles slowly about a wandering axis, like a camera adrift, and the
orbit is gimbal-free (`FreeOrbitControls.js`, from genuary-2026) with inertia. The prints are all defined through space
(stripes, spots, latitude bands, beach ball, candy swirl, giraffe, camo, coral, wood, agate, Damascus, marble), so no
shape shows a seam; their noise comes from a small baked texture (`noise.js`), which keeps the shader quick to compile.
When a change of look lands, the water is tapped twice to set it moving.

Controls:

- Tap the water for ripples; hold for a dent; drag over it to stir; drag off its edge to pull a drop; swipe to spin.
- Drag the background to orbit, scroll to zoom. R for a new look; shapes morph, finishes sweep across and backgrounds
  crossfade.
- M or the speaker button: sound.

## Sound

A cabin bed (spacecraft hum and ventilation, warmer or emptier with each background) under water foley cut from CC0
recordings on freesound.org: a drop and the swell of its spreading ripple for each tap, a slosh while stirring, squishes as a tendril stretches, a bloop when it
snaps, plops as drops land and as the shape morphs, bubbles through the morph, a swirl and a whoosh for a spin.
Source recordings (all CC0):

- "Single Water Drop" by paespedro (174718), "water drop 1.aif" by beskhu (273870), "Water_drop_9.wav" (166325),
  "Drop - Water" by mattfinarelli (533146), "Water Drops.wav" by ReiyaManor (351623), "Water Droplets" by Legnalegna55
  (543649)
- "waterbloop.mp3" by kstargio (611642), "Bubbles_Single2.wav" by BMacZero (96125), "Bubbles 001.wav" by ristooooo1
  (539823)
- "viscous liquid fall in.aiff" by bevibeldesign (315931), "Water Sloshing" by vmgraw (235625), "Cup_Spoon_Swirl_1.wav"
  by flamingostrich (585002), "Squeezing a Slime Ball" by niittymaa (666969)
- "Rippling water natural souce.wav" by Rimmer (648332), "Water, Gentle Movement.wav" by Daen23 (431627)
- "Whoosh stereo light (transition)" by xkeril (701104)
- "ambient spacecraft hum" by AlaskaRobotics (221570), "control_room.wav" by Diboz (211683)
