import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, randomize, isRunning, setRunning, applyUrlState, keysHelp, setDay, loadingStep } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Group, InstancedMesh, BufferGeometry, BufferAttribute, Matrix4, Quaternion, Vector3, Color, TextureLoader, CanvasTexture, Vector2, SRGBColorSpace, NoColorSpace, LinearMipmapLinearFilter, DoubleSide } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironment } from "modules/pipeline/studio.js";
import { createAutoChange } from "modules/autoChange.js";
import { createTransport } from "../2/transport.js";
import { crackPane, slabArrays, mulberry32, TAU } from "./glass.js";

// A photo printed on a pane of glass, which is then hit and shatters, caught as a high-speed photograph (day 2's
// way: everything sits at start + velocity * t, so any moment of the burst can be shown, scrubbed or played).

const HALF = 1.5; // half the pane's side
const THICK = 0.085; // the glass's thickness
const FLIGHT = 1.9; // seconds of flight for each unit of the burst (0..1)
const GRAVITY = 9; // units per second squared
const MAX_CHIPS = 3000;

const defaults = {
  explosion: 0,
  spray: 0.7,
  rotation: 0,
  aperture: 0.15,
  auto: false,
  autoTime: 12,
};
const params = fromDefaults(defaults);
const load = { image: loadingStep(1, "Printing the glass…"), compile: loadingStep(3, "Compiling shaders…") };

const pipeline = new Pipeline(renderer, {
  background: [0.006, 0.007, 0.009],
  exposure: 1.0,
  saturation: 1.15,
  bloomStrength: 0.12,
  vignette: 0.55,
  grain: 0.02,
  shadow: { autoFit: true, denoise: true },
  depthOfField: { aperture: 0 },
});
createStudioEnvironment(renderer, {
  keyDirection: new Vector3(-0.55, 0.8, 0.5),
  keyIntensity: 9,
  keySize: 0.45,
  fill: 0.1,
  floor: 0.08,
  wall: 0.06,
  ceiling: 0.03,
});

pipeline.background.setRGB(0.006, 0.007, 0.009);
setDay(NaN); // (this folder's name would make it day 2, with day 2's nav and explainer link: it has neither)
document.title = "Shatter 2.2 · Codevember 2026";
const gui = new GUI("Shatter on glass", document.querySelector("#gui-container"), { expanded: false });
gui.addSlider("Explosion", params.explosion, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Chips", params.spray, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Sway", params.rotation, 0, 2, 0.01, { randomizable: false });
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui });
gui.addSlider("Aperture", params.aperture, 0, 1, 0.01, { randomizable: false });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
gui.show();

// (The data files change whenever the shatter is re-baked, so they are always fetched fresh.)
const fresh = (name) => new URL(name, import.meta.url).href + "?v=" + Date.now();

// The shards' motion is a rigid-body simulation baked in Blender (blender/glass-shatter.blend): the shard outlines,
// when each lets go, and every shard's position and rotation on every frame (float32: x y z, quaternion x y z w).
const baked = await (await fetch(fresh("./shatter.json"), { cache: "no-store" })).json();
const bakedMotion = new Float32Array(await (await fetch(fresh("./shatter.bin"), { cache: "no-store" })).arrayBuffer());

// ---------------------------------------------------------------- materials

const image = await load.image.track(new TextureLoader().loadAsync(new URL("./hamster.jpg", import.meta.url).href));
image.colorSpace = SRGBColorSpace;
image.anisotropy = renderer.capabilities.getMaxAnisotropy();
image.minFilter = LinearMipmapLinearFilter;
image.generateMipmaps = true;

// The glass. See-through (blended, far to near), so what is behind a shard shows through it:
//  front face: the photo printed on the glass, a little see-through, under a glossy skin that mirrors the key light
//    (a sharp glint and a soft bloom of it) and brightens toward grazing angles (Fresnel);
//  back face: the far surface of the slab, a pale green tint seen through it, with the print showing faintly through;
//  sides (the cracks): the thickness of the glass, aqua, bright where it meets the faces (light bouncing inside) and
//    deep green in the middle, more opaque the more edge-on they are.
const glassSurface = /* glsl */ `
vec3 glassGlint(vec3 N, float alpha) {
  vec3 V = normalize(cameraPosition - vWorldPosition);
  vec3 R = reflect(-V, N);
  float k = max(dot(R, normalize(lightDirection)), 0.0);
  // A sharp glint of the softbox and a wide soft one, brought up by 1 / alpha: the blend would scale them down.
  return lightColor * (pow(k, 700.0) * 0.9 + pow(k, 40.0) * 0.04) / max(alpha, 0.2);
}
float glassFresnel(vec3 N) {
  vec3 V = normalize(cameraPosition - vWorldPosition);
  return pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
}
`;
const shardMaterial = new PipelineMaterial({
  roughness: 0.04,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  uniforms: { tImage: { value: image }, broken: { value: 1 } },
  varyings: { vKind: "float" },
  vertexPars: "in float kind;",
  vertexMain: "vKind = kind;",
  fragmentPars: ["uniform sampler2D tImage;", "uniform float broken;", glassSurface].join("\n"),
  surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 N = normalize(s.normal);
  float fres = glassFresnel(N);
  s.specular = 1.6;
  s.roughness = 0.04;
  if (vKind > 0.5 && vKind < 1.5) {
    // Thickness: z runs from the back face (-1) to the front (+1).
    float z = abs(vObjectPosition.z) / ${(THICK / 2).toFixed(5)};
    // (From the Blender reference: the thickness is a deep, saturated teal, with a bright line where the edge meets
    // either face, and the more edge-on, the more solid it reads.)
    float rim = pow(clamp(z, 0.0, 1.0), 3.5);
    vec3 deep = vec3(0.0, 0.13, 0.1);
    vec3 bright = vec3(0.4, 0.9, 0.76);
    s.alpha = clamp(0.72 + 0.28 * fres + 0.15 * rim, 0.0, 1.0) * broken;
    s.albedo = vec3(0.08, 0.34, 0.27);
    s.emissive = (mix(deep, bright, rim) * (0.45 + 0.55 * fres) + glassGlint(N, s.alpha) * 0.5) / max(s.alpha, 0.05);
  } else if (vKind > 1.5) {
    // The far surface, and the print through the glass, faint and mirrored.
    vec3 img = texture(tImage, vUv).rgb;
    // The far surface, seen through the thickness: teal, and darker the more slanted the way through.
    s.alpha = clamp(0.3 + 0.5 * fres, 0.0, 1.0) * broken;
    s.albedo = mix(vec3(0.3, 0.6, 0.5), img * vec3(0.6, 0.85, 0.75), 0.35);
    s.emissive = (mix(vec3(0.0, 0.025, 0.02), img * 0.06, 0.35) + glassGlint(N, s.alpha) * 0.6) / max(s.alpha, 0.05);
  } else {
    vec3 img = texture(tImage, vUv).rgb;
    // Whole, the print is one opaque sheet; broken, a little of what is behind shows through.
    s.alpha = mix(1.0, 0.9, broken);
    // Through the glass at a slant the light has further to go, so the print goes a little teal and darker
    // (Blender's absorbing glass does the same).
    vec3 V = normalize(cameraPosition - vWorldPosition);
    float path = 1.0 / max(abs(dot(N, V)), 0.25);
    float slant = clamp((path - 1.0) * 0.45, 0.0, 1.0);
    vec3 through = mix(vec3(1.0), vec3(0.6, 0.9, 0.8), slant * broken);
    s.albedo = img * 0.93 * through;
    // A print on glass reads as lit from behind a little, so it never goes muddy.
    s.emissive = img * 0.13 * through + glassGlint(N, s.alpha) + vec3(0.7, 0.85, 0.8) * fres * 0.3;
  }
}`,
});
const chipMaterial = new PipelineMaterial({
  color: 0xcfeee4,
  roughness: 0.04,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  fragmentPars: glassSurface,
  surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 N = normalize(s.normal);
  float fres = glassFresnel(N);
  s.specular = 1.8;
  s.alpha = clamp(0.35 + 0.55 * fres, 0.0, 1.0);
  s.emissive = (vec3(0.04, 0.18, 0.14) * (0.5 + fres) + glassGlint(N, s.alpha)) / max(s.alpha, 0.05);
}`,
});

// A piece that has not let go yet: the print on the glass, and nothing else of the slab: the pane is one plain sheet
// until each piece gives way.
const restMaterial = new PipelineMaterial({
  roughness: 0.04,
  uniforms: { tImage: { value: image } },
  varyings: { vKind: "float" },
  vertexPars: "in float kind;",
  vertexMain: "vKind = kind;",
  fragmentPars: ["uniform sampler2D tImage;", glassSurface].join(String.fromCharCode(10)),
  surface: /* glsl */ `
void surface(inout Surface s) {
  if (vKind > 0.5) discard;
  vec3 N = normalize(s.normal);
  vec3 img = texture(tImage, vUv).rgb;
  s.specular = 1.6;
  s.roughness = 0.04;
  s.albedo = img;
  // Whole, it is one plain sheet of glass with the print on it; nothing marks where it will break.
  s.emissive = img * 0.2 + glassGlint(N, 1.0) + vec3(0.7, 0.85, 0.8) * glassFresnel(N) * 0.4;
}`,
});

// ---------------------------------------------------------------- the pane

const scene = new Scene();
const group = new Group();
scene.add(group);
const pieces = new Group();
group.add(pieces);

function geometryFrom({ pos, nor, uv, kind }) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute("kind", new BufferAttribute(new Float32Array(kind), 1));
  g.computeBoundingSphere();
  return g;
}

// Small splinters: thin triangular slabs.
const chipShapes = [0, 1, 2].map((i) => {
  const r = mulberry32(77 + i);
  const poly = [];
  const n = 3 + (i % 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + (r() - 0.5) * 0.5;
    const d = 0.7 + 0.5 * r();
    poly.push([Math.cos(a) * d * (i === 2 ? 1.8 : 1), Math.sin(a) * d]);
  }
  const g = geometryFrom(slabArrays(poly, [0, 0], 0.5, 1));
  g.deleteAttribute("kind");
  return g;
});
const chipMeshes = chipShapes.map((g) => new InstancedMesh(g, chipMaterial, Math.ceil(MAX_CHIPS / chipShapes.length)));
for (const m of chipMeshes) {
  m.frustumCulled = false;
  group.add(m);
}

let crackReach = 1;
let seed = 7;
let built = null;
let shards = [];
let chips = [];
let impact = new Vector3();

function randomDirection(rand) {
  const z = rand() * 2 - 1;
  const a = rand() * TAU;
  const s = Math.sqrt(1 - z * z);
  return new Vector3(Math.cos(a) * s, Math.sin(a) * s, z);
}

// Everything's start and velocity, from the seed.
function build() {
  for (const s of shards) {
    pieces.remove(s.mesh);
    s.mesh.geometry.dispose();
  }
  // The splinters come from the seed; the shards are the baked ones, so a new impact (R) replays the same break.
  const rand = mulberry32(seed ^ 0x9e3779b1);
  const [ix, iy] = baked.impact;
  impact.set(ix, iy, 0);
  const cells = baked.cells;
  crackReach = Math.max(...cells.map((c) => Math.hypot(c.centre[0] - ix, c.centre[1] - iy)));
  shards = cells.map((cell, index) => ({
    mesh: pieces.add(new Mesh(geometryFrom(slabArrays(cell.poly, cell.centre, THICK, HALF, -0.0015, cell.tris)), restMaterial)).children.at(-1),
    index,
    start: cell.start,
  }));

  chips = [];
  for (let i = 0; i < MAX_CHIPS; i++) {
    const r = 1.4 * rand() ** 1.7;
    const a = rand() * TAU;
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    const e = Math.exp(-r / 0.9) + 0.1;
    const big = rand() < 0.03;
    chips.push({
      origin: new Vector3(ix + dx, iy + dy, (rand() - 0.5) * THICK),
      velocity: new Vector3(dx, dy, 0).normalize().multiplyScalar((0.6 + 4.5 * rand()) * e).add(new Vector3(0, 0, (0.4 + 3.2 * rand()) * e + 0.2)),
      start: crackTime(r * 0.7) + 0.045 + 0.03 * rand(),
      size: big ? 0.07 + 0.07 * rand() : 0.012 + 0.04 * rand() ** 2,
      axis: randomDirection(rand),
      spin: 3 + 14 * rand(),
      turn: randomDirection(rand),
    });
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _z = new Vector3(0, 0, 1);
const HIDE = new Matrix4().makeScale(0, 0, 0);

// Where something thrown at `velocity` is `u` seconds after it let go: a little air drag, and gravity (0..1 of it).
function flight(out, from, velocity, u, drag, gravity) {
  const d = (1 - Math.exp(-drag * u)) / drag;
  return out.copy(from).addScaledVector(velocity, d).setY(from.y + velocity.y * d - 0.5 * GRAVITY * gravity * u * u);
}

// When the front of the crack reaches distance r from the impact (as a share of the burst), and where it is at a time.
const CRACK_END = 0.2;
const crackTime = (r) => 0.01 + CRACK_END * Math.min(1, r / crackReach) ** 0.9;

function place() {
  const burst = params.explosion();
  // The shards: the baked frame, blended between two frames. Each is part of the sheet until it lets go.
  const f = burst * (baked.frames - 1);
  const i0 = Math.min(baked.frames - 2, Math.floor(f));
  const k = f - i0;
  for (const sh of shards) {
    const a = (i0 * baked.count + sh.index) * 7;
    const b = a + baked.count * 7;
    const m = bakedMotion;
    sh.mesh.position.set(m[a] + (m[b] - m[a]) * k, m[a + 1] + (m[b + 1] - m[a + 1]) * k, m[a + 2] + (m[b + 2] - m[a + 2]) * k);
    sh.mesh.quaternion.set(m[a + 3], m[a + 4], m[a + 5], m[a + 6]).slerp(_q2.set(m[b + 3], m[b + 4], m[b + 5], m[b + 6]), k);
    sh.mesh.material = burst > sh.start ? shardMaterial : restMaterial;
  }
  const count = Math.round(MAX_CHIPS * params.spray());
  chips.forEach((c, i) => {
    const k = i % chipMeshes.length;
    const mesh = chipMeshes[k];
    const at = Math.floor(i / chipMeshes.length);
    const u = Math.max(0, burst - c.start) * FLIGHT;
    if (i >= count || u <= 0) return mesh.setMatrixAt(at, HIDE);
    flight(_p, c.origin, c.velocity, u, 0.6, 0.9);
    _q.setFromAxisAngle(c.axis, c.spin * u).multiply(_q2.setFromUnitVectors(_z, c.turn));
    mesh.setMatrixAt(at, _m.compose(_p, _q, _s.set(c.size, c.size, c.size * 0.35)));
  });
  for (const m of chipMeshes) m.instanceMatrix.needsUpdate = true;
}

let placedKey = null;
function update() {
  const key = `${seed}`;
  if (key !== built) {
    built = key;
    build();
    placedKey = null;
    pipeline.restartAccumulation();
  }
  const pk = `${built}|${params.explosion()}|${params.spray()}`;
  if (pk !== placedKey) {
    placedKey = pk;
    place();
    // The lens average over still frames must start over when anything has moved (a scrub, or playing).
    pipeline.restartAccumulation();
  }
  // Focus on the pane itself (the photo is at the origin), not the orbit target, which sits a little behind it. Pieces
  // thrown toward the camera, and the ones that fall away behind the plane, soften with distance from it.
  pipeline.dof.focus = Math.max(camera.near * 2, camera.position.length());
  pipeline.dof.aperture = params.aperture() * 0.03;
}

onRandomize(() => {
  seed = Math.floor(Math.random() * 2 ** 31);
});

// ---------------------------------------------------------------- camera

camera.near = 0.2;
camera.far = 60;
camera.updateProjectionMatrix();
camera.position.set(0.55, 0.3, 7);
controls.target.set(0, 0, 0.3);
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 14;
controls.autoRotate = false;

const FRAME_RADIUS = 2.2;
onResize((w, h, dpr) => {
  const half = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, w / h));
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(Math.min(controls.maxDistance, FRAME_RADIUS / Math.sin(half)));
  camera.position.copy(controls.target).add(offset);
  pipeline.setSize(w, h, dpr);
});

const transport = createTransport({
  value: params.explosion,
  onRandomize: randomize,
  onPlay: () => isRunning() || setRunning(true),
});

// A speck of glass in the scene so its shader compiles with the rest, not when the first piece lets go.
const speck = new Mesh(chipShapes[0], shardMaterial);
speck.scale.setScalar(1e-5);
speck.frustumCulled = false;
scene.add(speck);

applyUrlState();
update();
await load.compile.track(pipeline.compileAsync(scene, camera), 3);

// Opening the page, and every new impact (R, the shuffle button), plays the burst once in slow motion and holds the
// last moment, so the bar can be scrubbed back and forth. Auto change (off unless the panel turns it on) brings a new
// impact every Change every seconds.
const BURST_SECONDS = 7;
function burst() {
  params.explosion.set(0);
  transport.play(1, BURST_SECONDS);
}
onRandomize(burst);
if (!new URLSearchParams(location.search).has("explosion")) burst();

let clock = 0;
render(({ dt }) => {
  clock += dt;
  autoChange.update(dt);
  transport.update(dt);
  update();
  // The whole pane sways a little, so the light slides over the glass.
  group.rotation.y = Math.sin(clock * 0.35) * 0.45 * params.rotation();
  group.rotation.x = Math.sin(clock * 0.23 + 1) * 0.12 * params.rotation();
  controls.update(dt);
  pipeline.render(scene, camera, 0);
});
