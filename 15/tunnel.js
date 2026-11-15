// The neon tunnel the card dashes through: a tube along -z that winds away ahead (straight at the card, bending more
// the further down it) and slowly rolls, its wall in a run of neon styles, one a section. Toward each section's end the
// next one comes in over it piece by piece, and the tube's shape blends into the next one's. Its live image is what the
// glass and foil reflect.
import { Mesh, Scene, CylinderGeometry, ShaderMaterial, BackSide, PMREMGenerator, Vector3, Color, GLSL3, WebGLCubeRenderTarget, CubeCamera, HalfFloatType } from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { applyEnvironment, computeSH } from "modules/pipeline/studio.js";

export const TUNNEL_STYLES = ["tiles", "rings", "hex", "grid"];
const RADIUS = 3.2;
const NEAR = 400;
const FAR = -260;

const SECTION = 140;
const BLEND = 60;
const section = /* glsl */ `
// The run of styles: a section's style, the next one's, and how far the next has come in (0..1) at s.
float tStyleOf(float k) { return floor(fract(k * 0.618034 + 0.31) * 4.0); }
vec3 tStyles(float s) {
  float k = floor(s / ${SECTION}.0);
  return vec3(tStyleOf(k), tStyleOf(k + 1.0), smoothstep(${SECTION - BLEND}.0, ${SECTION}.0, s - k * ${SECTION}.0));
}
// How far the tube has rolled at s.
float tRoll(float s) { return tunnelTime * 0.12 + s * 0.006; }
// The cross-section's radius at angle a, as a share of the tube's: 1 round, a hexagon for the hex style.
float tSection(float style, float a) {
  if (style != 2.0) return 1.0;
  float k = 6.2831853 / 6.0;
  return cos(k * 0.5) / cos(mod(a + k * 0.5, k) - k * 0.5);
}
`;

const wall = /* glsl */ `
${section}
const float RADIUS_T = ${RADIUS.toFixed(1)};
// The lattice every style is drawn on, so their lines run on from one into the next: 24 lanes round the tube, and a
// unit along it as long as a lane is wide.
const float LANES = 24.0;
const float UNIT = 6.2831853 * RADIUS_T / LANES;
uniform float tunnelStreaks;
uniform float tunnelDots;
// The angle's screen derivative, without the jump where atan wraps.
float tAngleWidth(float a) { return min(fwidth(a), fwidth(mod(a + 6.2831853, 6.2831853) - 3.14159265)); }
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
// The 2 x 2 Bayer order: 0 2 / 3 1.
float tBayer2(vec2 q) { return q.x < 0.5 ? (q.y < 0.5 ? 0.0 : 3.0) : (q.y < 0.5 ? 2.0 : 1.0); }
// Smooth value noise in 0..1.
float tNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tHash3(i), tHash3(i + vec3(1, 0, 0)), f.x), mix(tHash3(i + vec3(0, 1, 0)), tHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(tHash3(i + vec3(0, 0, 1)), tHash3(i + vec3(1, 0, 1)), f.x), mix(tHash3(i + vec3(0, 1, 1)), tHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 tPalette(float i) {
  i = mod(i, 4.0);
  return i < 1.0 ? vec3(1.0, 0.3, 0.05) : i < 2.0 ? vec3(0.06, 0.7, 1.0) : i < 3.0 ? vec3(1.0, 0.1, 0.5) : vec3(0.55, 0.18, 1.0);
}
// A neon line at distance r from its centre.
float tNeon(float r, float width, float w) {
  // A crisp, bright core only: the glow round it is the bloom's.
  return (1.0 - smoothstep(width, width + w, r)) * 4.0;
}

// Emission of the wall in one style at angle a, s metres down the tunnel, d ahead of the card; blur widens lines (for
// the environment's blurred bake); da, ds: screen widths of a radian and a metre.
vec3 tunnelWall(float style, float a, float s, float d, float blur, float da, float ds) {
  vec3 col = vec3(0.0);
  if (style == 0.0) {
    // Rounded square tiles in bands of colour, a few dark.
    vec2 uv = vec2(a / 6.2831853 * LANES, s / UNIT);
    float wa = da / 6.2831853 * LANES;
    // Tile ids wrap round the tube, so the tiles either side of where the angle wraps are one.
    vec2 id = vec2(mod(floor(uv.x), LANES), floor(uv.y));
    vec2 f = fract(uv) - 0.5;
    vec2 q = abs(f) - 0.25;
    float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.08;
    float w = max(ds / UNIT, wa) + blur;
    float h = tHash(id);
    float lit = h > 0.2 ? 1.0 : 0.06;
    // Waves of light chase round the tiles in a spiral.
    float chase = 0.5 + 0.5 * sin(6.2831853 * (id.x / LANES + id.y / 24.0) - tunnelTime * 2.2);
    lit *= 0.45 + 1.1 * chase * chase * chase;
    float glow = mix(tNeon(abs(box), 0.025, w), 0.3, smoothstep(0.15, 0.5, w));
    col = tPalette(floor(id.y / 9.0) + step(0.8, h)) * glow * lit;
    col += vec3(0.01, 0.002, 0.025);
  } else if (style == 1.0) {
    // Sparse rings, cyan and magenta, over a deep blue wall with a glossy purple floor.
    float v = s / (4.0 * UNIT);
    float k = floor(v + 0.5);
    float r = abs(fract(v + 0.5) - 0.5) * 4.0 * UNIT;
    float w = ds + blur;
    vec3 ring = mod(k, 2.0) < 1.0 ? vec3(0.12, 0.55, 1.0) : vec3(0.85, 0.15, 1.0);
    // Each ring breathes on its own beat.
    float beat = 0.55 + 0.45 * sin(tunnelTime * 3.0 + k * 1.7);
    col = ring * mix(tNeon(r, 0.035, w), 0.5, smoothstep(0.6, 2.0, w)) * beat;
    // Fine rings between, and four light strips along the tube.
    float rFine = abs(fract(s / UNIT + 0.5) - 0.5) * UNIT;
    col += ring.bgr * mix(tNeon(rFine, 0.008, w), 0.15, smoothstep(0.2, 0.6, w)) * 0.12;
    float strip = abs(fract(a / 6.2831853 * 4.0 + 0.5) - 0.5) * 6.0 * UNIT;
    col += vec3(0.6, 0.3, 1.0) * mix(tNeon(strip, 0.02, da * 3.2 + blur), 0.1, smoothstep(0.3, 0.8, da * 3.2 + blur)) * 0.35;
    float floorBand = smoothstep(-0.6, -0.95, sin(a));
    col += vec3(0.02, 0.012, 0.1) + vec3(0.35, 0.06, 0.6) * floorBand * (0.25 + 0.5 * exp(-r / 0.6));
  } else if (style == 2.0) {
    // A hexagonal hall of dark panels in violet frames, a bright hex gate every few metres, and embers.
    float k = 6.2831853 / 6.0;
    float fa = mod(a + k * 0.5, k) / k;
    vec2 uv = vec2((floor((a + k * 0.5) / k) + fa) * 4.0, s / UNIT);
    vec2 f = fract(uv) - 0.5;
    vec2 id = vec2(mod(floor(uv.x), 24.0), floor(uv.y));
    float w = ds + blur;
    float rLine = min(0.5 - abs(f.x), 0.5 - abs(f.y)) * 1.1;
    col = vec3(0.45, 0.2, 1.0) * mix(tNeon(rLine, 0.012, w), 0.15, smoothstep(0.2, 0.6, w)) * 0.35;
    float g = s / (12.0 * UNIT);
    float gate = floor(g + 0.5);
    float rGate = abs(fract(g + 0.5) - 0.5) * 12.0 * UNIT;
    col += (mod(gate, 2.0) < 1.0 ? vec3(0.9, 0.25, 1.0) : vec3(0.3, 0.45, 1.0)) * mix(tNeon(rGate, 0.07, w), 0.6, smoothstep(0.6, 2.0, w));
    col += vec3(0.006, 0.003, 0.018);
    float h = tHash(id + 3.1);
    // A few panels glow from behind, fading in and out.
    float panel = smoothstep(0.75, 1.0, tHash(id + 5.7)) * (0.5 + 0.5 * sin(tunnelTime * 1.3 + h * 40.0));
    col += mix(vec3(0.25, 0.1, 0.8), vec3(0.8, 0.2, 0.9), tHash(id + 1.9)) * panel * 0.12 * smoothstep(0.5, 0.3, max(abs(f.x), abs(f.y)));
    if (h < 0.06 && blur == 0.0) {
      vec2 o = (vec2(tHash(id + 7.3), tHash(id + 9.1)) - 0.5) * 0.6;
      float flicker = 0.6 + 0.4 * sin(tunnelTime * 9.0 + h * 600.0);
      col += vec3(1.0, 0.45, 0.1) * exp(-dot(f - o, f - o) / 0.004) * 6.0 * flicker;
    }
  } else {
    // The synthwave grid: lines along and round the tube, magenta to cyan round it.
    vec2 uv = vec2(a / 6.2831853 * LANES, s / UNIT);
    vec2 dd = min(fract(uv), 1.0 - fract(uv));
    float w = max(da / 6.2831853 * LANES, ds / UNIT) + blur * 0.3;
    float lines = max(1.0 - smoothstep(0.012, 0.012 + 1.5 * w, dd.x), 1.0 - smoothstep(0.02, 0.02 + 1.5 * w, dd.y));
    lines = mix(lines, 0.06, smoothstep(0.25, 0.7, w));
    vec3 tint = mix(vec3(1.0, 0.1, 0.65), vec3(0.1, 0.85, 1.0), 0.5 + 0.5 * sin(a * 2.0 + s * 0.03));
    // Every fourth ring a bright one, and a scan of light sweeping round the tube.
    float major = 1.0 + 1.5 * step(mod(floor(uv.y + 0.5), 4.0), 0.5) * (1.0 - smoothstep(0.02, 0.02 + 1.5 * w, dd.y));
    float sweep = pow(0.5 + 0.5 * cos(a - tunnelTime * 1.5 + s * 0.05), 12.0);
    col = tint * lines * (1.6 + 2.4 * sweep) * major + vec3(0.012, 0.0, 0.025) + tint * sweep * 0.05;
  }
  // Pulses of light racing toward the card, faster than the wall.
  float wave = fract(s / 60.0 + tunnelTime * 0.45);
  float pulse = exp(-pow((wave - 0.5) * 20.0, 2.0));
  col *= 1.0 + 1.6 * pulse;
  // Down the tunnel (and back up it, behind the card) it fades into a coloured haze.
  vec3 haze = style == 0.0 ? vec3(0.5, 0.08, 0.2) : style == 1.0 ? vec3(0.15, 0.08, 0.5) : style == 2.0 ? vec3(0.25, 0.08, 0.45) : vec3(0.45, 0.06, 0.35);
  float far = exp(-abs(d) / 45.0);
  return col * far + haze * (1.0 - far) * 0.08 * smoothstep(0.0, 30.0, abs(d));
}

// Light speed (an overlay on any style): streaks of light racing along the tube in thin lanes, faster than the wall.
vec3 tStreaks(float a, float s, float da, float blur) {
  float lanes = 2.0 * LANES;
  float u = a / 6.2831853 * lanes;
  float lane = mod(floor(u), lanes);
  float r = abs(fract(u) - 0.5) * 6.2831853 * RADIUS_T / lanes;
  float h = tHash(vec2(lane, 3.0));
  float len = 18.0 + 22.0 * h;
  float q = s + tunnelTime * (25.0 + 45.0 * tHash(vec2(lane, 9.0)));
  float seg = floor(q / len);
  float x = fract(q / len);
  float on = step(tHash(vec2(lane, seg)), 0.3);
  // A bright head and a long fading tail behind it.
  float streak = on * smoothstep(0.0, 0.03, x) * pow(1.0 - x, 2.5) * step(x, 0.7) / 0.7;
  float w = da * RADIUS_T + blur;
  vec3 tint = mix(vec3(0.2, 0.7, 1.0), vec3(1.0, 0.2, 0.75), step(0.55, h));
  tint = mix(tint, vec3(1.0, 0.9, 0.95), step(0.9, tHash(vec2(lane, seg + 0.5))) * 0.7);
  return tint * mix(tNeon(r, 0.006, w), 0.12, smoothstep(0.05, 0.2, w)) * streak * 1.8;
}

// A dot spiral (an overlay on any style): rings of glowing points, each ring turned a little more than the last, the
// whole spiral turning as it comes.
vec3 tDots(float a, float s, float da, float ds, float blur) {
  float spacing = 1.1;
  float v = s / spacing;
  float k = floor(v + 0.5);
  float dv = (fract(v + 0.5) - 0.5) * spacing;
  float u = (a + k * 0.21 + tunnelTime * 0.5) / 6.2831853 * LANES;
  float du = (fract(u) - 0.5) * UNIT;
  float r = length(vec2(du, dv));
  float w = max(ds, da * RADIUS_T) + blur;
  vec3 tint = 0.5 + 0.5 * cos(6.2831853 * (k * 0.045 + vec3(0.0, 0.33, 0.67)));
  tint = mix(tint, vec3(1.0, 0.15, 0.7), 0.35);
  float twinkle = 0.6 + 0.4 * sin(tunnelTime * 4.0 + k * 0.9 + floor(u) * 2.4);
  return tint * mix(tNeon(r, 0.04, w), 0.15, smoothstep(0.15, 0.45, w)) * twinkle;
}

// The wall at raw angle a (atan's): the section's style, rolled, with the next one coming in over it block by block.
vec3 tunnelBlendAt(float a, float s, float d, float blur, float da, float ds) {
  vec3 st = tStyles(s);
  float ar = a + tRoll(s);
  vec3 col = tunnelWall(st.x, ar, s, d, blur, da, ds);
  if (st.z > 0.0) {
    vec3 next = tunnelWall(st.y, ar, s, d, blur, da, ds);
    // The next style replaces the old one tile by tile on the shared lattice: each cell switches whole, in an ordered
    // dither (a 4 x 4 Bayer order, roughened per cell), and flares a moment as it comes in.
    vec2 cell = vec2(mod(floor(ar / 6.2831853 * LANES), LANES), floor(s / UNIT));
    vec2 lo = mod(cell, 2.0), hi = floor(mod(cell, 4.0) / 2.0);
    float bayer = 4.0 * tBayer2(lo) + tBayer2(hi);
    float t = (bayer + 0.5) / 16.0 * 0.6 + tHash(cell + 4.2) * 0.4;
    float age = st.z * 1.1 - 0.05 - t;
    float m = step(0.0, age);
    float front = m * exp(-age * 25.0) * 2.0;
    col = col * (1.0 - m) * (1.0 - 0.5 * front) + next * (m + 0.8 * front);
  }
  float far = exp(-abs(d) / 45.0);
  if (tunnelStreaks > 0.001) col += tStreaks(ar, s, da, blur) * tunnelStreaks * far;
  if (tunnelDots > 0.001) col += tDots(ar, s, da, ds, blur) * tunnelDots * far;
  return col;
}

vec3 tunnelBlend(float a, float s, float d, float blur) {
  // Derivatives before any branch, and from the raw angle so its wrap is handled once.
  return tunnelBlendAt(a, s, d, blur, tAngleWidth(a), fwidth(s));
}

// The wall as a camera sees it while it streams past for a shutter: averaged over the len metres it travels then, with
// as many taps as that spans pixels (a third), up to 10.
vec3 tunnelBlendMoving(float a, float s, float d, float len) {
  float da = tAngleWidth(a);
  float ds = fwidth(s);
  int n = int(clamp(ceil(len / max(ds, 1e-5) / 3.0), 1.0, 10.0));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    float o = n == 1 ? 0.0 : len * ((float(i) + 0.5) / float(n) - 0.5);
    col += tunnelBlendAt(a, s + o, d + o, 0.0, da, ds);
  }
  return col / float(n);
}
`;

const bend = /* glsl */ `
uniform float tunnelTravel;
uniform float tunnelBend;
uniform float tunnelTime;
${section}
vec2 tCurve(float s) {
  return vec2(sin(s * 0.021) + 0.6 * sin(s * 0.037 + 2.0), 0.8 * sin(s * 0.017 + 1.0) + 0.4 * sin(s * 0.043)) * 18.0;
}
vec2 tSlope(float s) {
  return vec2(0.021 * cos(s * 0.021) + 0.0222 * cos(s * 0.037 + 2.0), 0.0136 * cos(s * 0.017 + 1.0) + 0.0172 * cos(s * 0.043)) * 18.0;
}
vec3 displace(vec3 p, inout vec3 n) {
  float s = tunnelTravel - p.z;
  vec3 st = tStyles(s);
  float a = atan(p.y, p.x) + tRoll(s);
  p.xy *= mix(tSection(st.x, a), tSection(st.y, a), st.z);
  // Off the straight line by how far the path has turned from where the card is heading: ahead, and behind (the way
  // it came), so neither end is ever seen straight on.
  float d = -p.z;
  p.xy += (tCurve(tunnelTravel + d) - tCurve(tunnelTravel) - tSlope(tunnelTravel) * d) * tunnelBend;
  return p;
}
`;

function tube(radial, rings) {
  const geometry = new CylinderGeometry(RADIUS, RADIUS, NEAR - FAR, radial, rings, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, (NEAR + FAR) / 2);
  return geometry;
}

// The style at s (metres down the tunnel), as the shaders pick it: whichever of the two is more in.
function styleAt(s) {
  const of = (k) => Math.floor(((((k * 0.618034 + 0.31) % 1) + 1) % 1) * TUNNEL_STYLES.length);
  const k = Math.floor(s / SECTION);
  const f = s - k * SECTION;
  return f > SECTION - BLEND / 2 ? of(k + 1) : of(k);
}

export function createTunnel(renderer) {
  const uniforms = {
    tunnelTravel: { value: 0 },
    tunnelBend: { value: 1 },
    tunnelTime: { value: 0 },
    tunnelStreaks: { value: 0 },
    tunnelDots: { value: 0 },
    tunnelBlurLen: { value: 0 },
  };
  const material = new PipelineMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    side: BackSide,
    uniforms,
    vertex: bend,
    varyings: { vTube: "vec3" },
    vertexMain: "vTube = vec3(position.xy, tunnelTravel - position.z);",
    fragmentPars: `uniform float tunnelTravel;\nuniform float tunnelTime;\nuniform float tunnelBlurLen;\n${wall}`,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        s.albedo = vec3(0.0);
        s.roughness = 1.0;
        s.emissive = tunnelBlendMoving(atan(vTube.y, vTube.x), vTube.z, vTube.z - tunnelTravel, tunnelBlurLen);
      }
    `,
  });
  const mesh = new Mesh(tube(192, 500), material);
  mesh.userData.noShadow = true;
  mesh.userData.noWireframe = true;
  mesh.frustumCulled = false;

  const env = createEnvironmentBaker(renderer, uniforms);
  let envStyle = -1;
  return {
    mesh,
    env,
    uniforms,
    // speed: metres a second.
    // streaks, dots: the overlays' strengths (0..1), eased to.
    // shutter: seconds of motion blur along the tunnel (0 for none).
    update(dt, speed, bendAmount = 1, { streaks = 0, dots = 0, shutter = 0 } = {}) {
      const u = uniforms;
      const k = 1 - Math.exp(-2 * dt);
      u.tunnelStreaks.value += (streaks - u.tunnelStreaks.value) * k;
      u.tunnelDots.value += (dots - u.tunnelDots.value) * k;
      u.tunnelTravel.value += dt * speed;
      u.tunnelBlurLen.value = speed * shutter;
      u.tunnelTime.value += dt;
      u.tunnelBend.value = bendAmount;
      // The ambient light follows the style round the card.
      const here = styleAt(u.tunnelTravel.value);
      if (here !== envStyle) env.bake((envStyle = here));
      env.update();
    },
    // Bakes every style's ambient light, a frame apart, so a change of style never waits on one.
    async prebake(yieldFrame) {
      for (let style = 0; style < TUNNEL_STYLES.length; style++) {
        env.bake(style);
        await yieldFrame();
      }
      env.bake(envStyle);
    },
    // Starts somewhere along the run of styles.
    jump(travel) {
      uniforms.tunnelTravel.value = travel;
    },
  };
}

// The tunnel as the environment. Ambient light: each style's, baked once, straight and still. Reflections: the tunnel
// itself as it moves and bends, rendered round the card into a cube each frame and prefiltered.
function createEnvironmentBaker(renderer, live) {
  const scene = new Scene();
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    uniforms: { uStyle: { value: 0 }, tunnelTime: { value: 0 } },
    vertexShader: `uniform float uStyle; uniform float tunnelTime; out vec3 vP;\n${section}\nvoid main() { vP = position; vec3 p = position; p.xy *= tSection(uStyle, atan(p.y, p.x)); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uStyle; uniform float tunnelTime; in vec3 vP; out vec4 o;\n${wall}\nvoid main() { float a = atan(vP.y, vP.x); o = vec4(tunnelWall(uStyle, a, -vP.z, -vP.z, 0.08, tAngleWidth(a), fwidth(vP.z)), 1.0); }`,
  });
  scene.add(new Mesh(tube(96, 120), material));
  const pmrem = new PMREMGenerator(renderer);
  const baked = new Map();

  const liveScene = new Scene();
  const liveMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    uniforms: live,
    vertexShader: `out vec3 vTube;\n${bend}\nvoid main() { vec3 n = normal; vTube = vec3(position.xy, tunnelTravel - position.z); gl_Position = projectionMatrix * modelViewMatrix * vec4(displace(position, n), 1.0); }`,
    fragmentShader: `uniform float tunnelTravel; uniform float tunnelTime; in vec3 vTube; out vec4 o;\n${wall}\nvoid main() { o = vec4(tunnelBlend(atan(vTube.y, vTube.x), vTube.z, vTube.z - tunnelTravel, 0.03), 1.0); }`,
  });
  liveScene.add(new Mesh(tube(96, 260), liveMaterial));
  const cube = new WebGLCubeRenderTarget(128, { type: HalfFloatType });
  const cubeCamera = new CubeCamera(0.1, 600, cube);
  const livePmrem = new PMREMGenerator(renderer);
  let liveTarget = null;
  return {
    // The style's ambient light and key.
    bake(style) {
      if (!baked.has(style)) {
        material.uniforms.uStyle.value = style;
        const target = pmrem.fromScene(scene, 0, 0.1, 600, { size: 64 });
        baked.set(style, {
          envMap: target.texture,
          renderTarget: target,
          sh: computeSH(renderer, target.texture),
          lightDirection: new Vector3(0.25, 0.7, 0.65).normalize(),
          lightColor: new Color(1.0, 0.55, 0.75).multiplyScalar(2.2),
          shadowLightSize: 0.25,
        });
      }
      applyEnvironment(baked.get(style));
      if (liveTarget) globalUniforms.envMap.value = liveTarget.texture;
    },
    // This frame's reflections.
    update() {
      cubeCamera.update(renderer, liveScene);
      liveTarget = livePmrem.fromCubemap(cube.texture, liveTarget);
      globalUniforms.envMap.value = liveTarget.texture;
      globalUniforms.envMapMaxLod.value = Math.max((liveTarget.texture.mipmaps?.length ?? 1) - 1, 0);
    },
  };
}
