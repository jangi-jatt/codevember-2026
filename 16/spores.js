// The colony as a particle simulation on the GPU. Every spore has a position and a velocity that persist from frame to
// frame. Each step:
//   1. the spores are splatted into a 64³ density grid (a 2D atlas of slices) and blurred at two radii;
//   2. every spore is pushed apart where the fine density is over-packed (pressure), pulled up the wide density's
//      gradient (cohesion: the mass holds together like a goo and rounds itself off), held to a few clump-mates by
//      elastic bonds (bead clusters that stretch, wobble and swing), stirred by a slowly changing curl-noise current,
//      shoved by the pointer, and damped; then moved.
// The instanced impostor spheres read their place from the position texture; the previous one gives motion vectors.
import {
  DataTexture,
  RGBAFormat,
  RGFormat,
  FloatType,
  HalfFloatType,
  NearestFilter,
  LinearFilter,
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Points,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  CustomBlending,
  AddEquation,
  OneFactor,
  NoBlending,
  Vector3,
  Color,
  Sphere,
} from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";

const SIZE = 512;
// Update passes per simulation step (?substeps=2 for the old two, to compare). With one, drag is scaled to match two's
// motion and tearing (measured: spore speeds and intact bonds within a few percent).
const SUBSTEPS = Math.max(1, Math.round(Number(new URLSearchParams(location.search).get("substeps")) || 1));
const ONE_PASS_DRAG = 0.875;
const MAX_SPORES = SIZE * SIZE;
// Density grid: G³ cells over a box of half-size BOX, as TILES x TILES slices in an ATLAS² texture.
const G = 64;
const TILES = 8;
const ATLAS = G * TILES;
const BOX = 2.2;
const CELL = (2 * BOX) / G;
// The volume the colony settles to (a ball of radius 1) when density is 1 everywhere inside.
const VOLUME = (4 / 3) * Math.PI;
const BONDS = 4;
// Fine grid for collisions between spores: GF³ cells about a grain across, over a box of half-size BOXF, as 16 x 8
// slices in a 2048 x 1024 atlas. Its density is the packing fraction (grain volume per cell volume).
const GF = 128;
const TFX = 16;
const TFY = 8;
const BOXF = 1.7;
const CELLF = (2 * BOXF) / GF;

// Lighting per grain, once a frame (instead of per vertex in every pass), eased over a few frames so grains near a
// shadow's edge don't flicker as they jostle. r: the key at the grain's lit side (hardware-filtered taps); g: light
// scattered through the mass to it.
const lightFragment = /* glsl */ `
precision highp float;
precision highp sampler2DShadow;
uniform sampler2D tPos;
uniform sampler2D tPrev;
uniform mat4 colonyMatrix;
uniform vec3 lightDirection;
uniform highp sampler2D shadowMap;
uniform sampler2DShadow shadowMapCmp;
uniform mat4 shadowMatrix;
uniform vec2 shadowMapSize;
uniform float shadowEnabled;
uniform float radius;
uniform float translucency;
uniform float blend;
out vec4 outColor;
float sporeLit(vec3 centre) {
  vec4 sc = shadowMatrix * vec4(centre + normalize(lightDirection) * radius * 1.5, 1.0);
  vec3 q = sc.xyz / sc.w * 0.5 + 0.5;
  if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) return 1.0;
  vec2 texel = 0.75 / shadowMapSize;
  return 0.25 * (texture(shadowMapCmp, vec3(q.xy + vec2(-texel.x, -texel.y), q.z - 0.0015))
    + texture(shadowMapCmp, vec3(q.xy + vec2(texel.x, -texel.y), q.z - 0.0015))
    + texture(shadowMapCmp, vec3(q.xy + vec2(-texel.x, texel.y), q.z - 0.0015))
    + texture(shadowMapCmp, vec3(q.xy + vec2(texel.x, texel.y), q.z - 0.0015)));
}
float sporeThrough(vec3 centre, float mfp) {
  vec4 sc = shadowMatrix * vec4(centre, 1.0);
  vec3 q = sc.xyz / sc.w * 0.5 + 0.5;
  if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
  float uvPerWorld = 0.5 * length(vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]));
  float worldPerDepth = 2.0 / length(vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]));
  float spread = 1.5 * mfp * uvPerWorld;
  float t = 0.0;
  for (int i = 0; i < 5; i++) {
    float a = float(i) * 1.5707963 + 0.4;
    vec2 o = i == 0 ? vec2(0.0) : vec2(cos(a), sin(a)) * spread;
    float thick = max(min(q.z, 1.0) - textureLod(shadowMap, q.xy + o, 0.0).r, 0.0) * worldPerDepth;
    t += exp(-thick / mfp);
  }
  return t * 0.2;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 light = vec2(1.0, translucency > 0.0 ? 1.0 : 0.0);
  if (shadowEnabled > 0.5) {
    vec3 centre = (colonyMatrix * vec4(texelFetch(tPos, c, 0).xyz, 1.0)).xyz;
    light.r = sporeLit(centre);
    light.g = translucency > 0.0 ? sporeThrough(centre, mix(0.01, 0.08, translucency)) : 0.0;
  }
  outColor = vec4(mix(texelFetch(tPrev, c, 0).rg, light, blend), 0.0, 1.0);
}
`;

const defs = /* glsl */ `
#define SIZE ${SIZE}
#define G ${G}.0
#define TILES ${TILES}.0
#define ATLAS ${ATLAS}.0
#define BOX ${BOX}
#define CELL ${CELL}
#define GF ${GF}.0
#define TFX ${TFX}.0
#define BOXF ${BOXF}
#define CELLF ${CELLF}
ivec2 texelOf(int i) { return ivec2(i % SIZE, i / SIZE); }
vec2 tileOf(float z) { return vec2(mod(z, TILES), floor(z / TILES)); }
vec2 fineTileOf(float z) { return vec2(mod(z, TFX), floor(z / TFX)); }
// Which colony a spore belongs to (by its clump, so clumps never straddle two).
float colonyHash(float clumpStart) { return fract(sin(mod(clumpStart, 977.0) * 0.1271 + 1.7) * 43758.5453); }
int colonyOf(float clumpStart, float colonies) { return int(min(floor(colonyHash(clumpStart) * colonies), colonies - 1.0)); }
// A spore's patch value (every colony has the same mix of dark and crust; colonies differ in their crust colour).
float baseDye(vec4 meta, float colonies) { return meta.z; }
// Dark (0) or crust (1): a spore's own class, from its patch and colony, never changing.
float sporeClass(vec4 meta, float colonies, float crust) {
  return smoothstep(-0.08, 0.08, baseDye(meta, colonies) - mix(1.05, -0.05, crust));
}
`;

// 3D simplex noise with its analytic gradient (webgl-noise, Ashima / Gustavson): xyz = gradient, w = value.
const noiseGLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec4 snoiseD(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 temp = m2 * m * pdotx;
  vec3 grad = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 105.0 * vec4(grad, dot(m4, pdotx));
}
vec3 curl(vec3 p) {
  vec4 a = snoiseD(p);
  vec4 b = snoiseD(p + vec3(31.416, 17.32, -9.17));
  vec4 c = snoiseD(p + vec3(-23.71, 41.13, 7.77));
  return vec3(c.y - b.z, a.z - c.x, b.x - a.y);
}
`;

const quadVertex = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }
`;

// Copies the initial state into a simulation target (both outputs).
const initFragment = /* glsl */ `
precision highp float;
${defs}
uniform sampler2D tInitPos;
uniform sampler2D tMeta;
uniform float colonies;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
layout(location = 2) out vec4 outBond;
layout(location = 3) out vec4 outState;
void main() {
  outPos = texelFetch(tInitPos, ivec2(gl_FragCoord.xy), 0);
  outVel = vec4(0.0);
  outBond = vec4(1.0);
  // Sporulation age (0 attached, > 0 ripening then released, < 0 regrowing), render scale, bud flag.
  outState = vec4(0.0, 1.0, 0.0, 0.5);
}
`;

// One point per spore into the grid, split between the two nearest slices.
const splatVertex = /* glsl */ `
precision highp float;
${defs}
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float sliceOffset;
uniform float weight;
out float vWeight;
out vec3 vVel;
void main() {
  vec3 p = texelFetch(tPos, texelOf(gl_VertexID), 0).xyz;
  vVel = texelFetch(tVel, texelOf(gl_VertexID), 0).xyz;
  vec3 g = (p + BOX) / (2.0 * BOX) * G - 0.5;
  float z0 = floor(g.z);
  float fz = g.z - z0;
  float z = z0 + sliceOffset;
  vec2 xy = floor(g.xy + 0.5);
  vWeight = weight * (sliceOffset < 0.5 ? 1.0 - fz : fz);
  gl_PointSize = 1.0;
  if (min(min(xy.x, xy.y), z) < 0.0 || max(max(xy.x, xy.y), z) > G - 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 px = tileOf(z) * G + xy + 0.5;
  gl_Position = vec4(px / ATLAS * 2.0 - 1.0, 0.0, 1.0);
}
`;
const splatFragment = /* glsl */ `
precision highp float;
in float vWeight;
in vec3 vVel;
out vec4 outColor;
void main() { outColor = vec4(vWeight, vWeight * vVel); }
`;

// Fine grid: each spore spreads its grain volume trilinearly over its 8 cells: a 2x2 point per z slice, a cell per fragment.
const fineSplatVertex = /* glsl */ `
precision highp float;
${defs}
uniform sampler2D tPos;
uniform sampler2D tState;
uniform float grainVolume;
uniform sampler2D tMeta;
uniform float colonies;
uniform float crust;
out float vWeight;
out float vDye;
out vec2 vFrac;
flat out vec2 vBase;
void main() {
  vec3 p = texelFetch(tPos, texelOf(gl_InstanceID), 0).xyz;
  vec4 st = texelFetch(tState, texelOf(gl_InstanceID), 0);
  float scl = st.y;
  vDye = sporeClass(texelFetch(tMeta, texelOf(gl_InstanceID), 0), colonies, crust);
  vec3 g = (p + BOXF) / (2.0 * BOXF) * GF - 0.5;
  vec3 base = floor(g);
  vec3 f = g - base;
  float cz = float(gl_VertexID);
  float z = base.z + cz;
  vWeight = grainVolume * scl * scl * scl * mix(1.0 - f.z, f.z, cz);
  vFrac = f.xy;
  vBase = base.xy;
  gl_PointSize = 2.0;
  if (z < 0.0 || z > GF - 1.0 || min(base.x, base.y) < -1.0 || max(base.x, base.y) > GF - 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // The point's centre on the corner shared by its four cells.
  vec2 px = fineTileOf(z) * GF + base.xy + 1.0;
  gl_Position = vec4(px / vec2(GF * TFX, GF * ${TFY}.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

// A fine point's fragment is one of its four cells: its corner's share, nothing past the grid's edge (that's another tile).
const fineSplatFragment = /* glsl */ `
precision highp float;
${defs}
in float vWeight;
in float vDye;
in vec2 vFrac;
flat in vec2 vBase;
out vec4 outColor;
void main() {
  vec2 c = vec2(gl_PointCoord.x > 0.5 ? 1.0 : 0.0, gl_PointCoord.y > 0.5 ? 0.0 : 1.0);
  vec2 cell = vBase + c;
  if (min(cell.x, cell.y) < 0.0 || max(cell.x, cell.y) > GF - 1.0) discard;
  vec2 w = mix(1.0 - vFrac, vFrac, c);
  float weight = vWeight * w.x * w.y;
  outColor = vec4(weight, weight * vDye, 0.0, 0.0);
}
`;

// Separable 3D blur over the atlas, into two outputs: density (r = fine, gaussian sigma 1 cell, for pressure; g = wide,
// sigma 2.5 cells, for cohesion) and fine momentum (rgb, for viscosity). The first pass reads the raw splat (density,
// momentum) from one texture.
const blurFragment = /* glsl */ `
precision highp float;
${defs}
uniform sampler2D tDensity;
uniform sampler2D tMomentum;
uniform vec3 axis;
uniform float first;
layout(location = 0) out vec4 outDensity;
layout(location = 1) out vec4 outMomentum;
void cellValue(vec3 c, out vec2 rho, out vec3 mom) {
  rho = vec2(0.0);
  mom = vec3(0.0);
  if (min(min(c.x, c.y), c.z) < 0.0 || max(max(c.x, c.y), c.z) > G - 1.0) return;
  ivec2 t = ivec2(tileOf(c.z) * G + c.xy);
  vec4 a = texelFetch(tDensity, t, 0);
  if (first > 0.5) {
    rho = a.rr;
    mom = a.gba;
  } else {
    rho = a.rg;
    mom = texelFetch(tMomentum, t, 0).rgb;
  }
}
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 tile = floor(px / G);
  vec3 c = vec3(px - tile * G, tile.x + tile.y * TILES);
  vec2 sum = vec2(0.0);
  vec3 msum = vec3(0.0);
  vec2 norm = vec2(0.0);
  for (int k = -6; k <= 6; k++) {
    vec2 rho;
    vec3 mom;
    cellValue(c + axis * float(k), rho, mom);
    float fk = float(k);
    vec2 w = vec2(abs(k) <= 3 ? exp(-fk * fk / 2.0) : 0.0, exp(-fk * fk / 12.5));
    sum += rho * w;
    msum += mom * w.x;
    norm += w;
  }
  outDensity = vec4(sum / norm, 0.0, 0.0);
  outMomentum = vec4(msum / norm.x, 0.0);
}
`;

const updateFragment = /* glsl */ `
precision highp float;
${defs}
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tField;
uniform sampler2D tMomentum;
uniform float viscosity;
uniform sampler2D tMeta;
uniform sampler2D tRest;
uniform float dt;
uniform float time;
uniform float flowTime;
uniform vec3 offset;
uniform float turbulence;
uniform float scale;
uniform float pressure;
uniform float cohesion;
uniform float bond;
uniform float drag;
// Drag's scale for the number of update passes a step (see ONE_PASS_DRAG).
uniform float dragScale;
uniform float centering;
uniform sampler2D tBond;
uniform float tear;
uniform float heal;
uniform float restDensity;
uniform float pulseAmp;
uniform vec3 pulseDir;
uniform float pulseFocus;
uniform float pulseRate;
uniform vec3 burstOrigin;
uniform vec3 burstDir;
uniform vec3 burstCentre;
uniform float burstStrength;
uniform float burstRadius;
uniform vec3 rayOrigin;
uniform vec3 rayDir;
uniform vec3 rayVel;
uniform float pointerRadius;
uniform float pointerForce;
uniform sampler2D tFine;
uniform float finePressure;
uniform float fineRest;
uniform sampler2D tState;
uniform float crust;
uniform vec3 sporeDir;
uniform float sporeCone;
uniform float sporeChance;
uniform float stepId;
uniform vec3 budDir;
uniform vec3 budCentre;
uniform float budNeck;
uniform float budGrow;
uniform float budPinch;
uniform float budPull;
uniform float budMark;
uniform float budClear;
uniform float recall;
uniform float sorting;
uniform float colonies;
uniform vec3 centres[3];
uniform vec3 grabOrigin;
uniform vec3 grabDir;
uniform float grabRadius;
uniform float grabMark;
uniform float grabClear;
uniform vec3 grabTarget;
uniform float grabPull;
uniform vec3 attractPoint;
uniform float attract;
uniform float fling;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
layout(location = 2) out vec4 outBond;
layout(location = 3) out vec4 outState;
${noiseGLSL}
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
// Integer hash (PCG) for rare per-step events: the sin hash collapses to a few values for large arguments on GPUs.
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float random01(int index, float step) { return float(pcg(uint(index) ^ pcg(uint(step)))) * (1.0 / 4294967296.0); }

vec4 sampleAtlas(sampler2D t, vec3 p) {
  vec3 g = (p + BOX) / (2.0 * BOX) * G - 0.5;
  if (min(min(g.x, g.y), g.z) < -0.5 || max(max(g.x, g.y), g.z) > G - 0.5) return vec4(0.0);
  float z0 = clamp(floor(g.z), 0.0, G - 1.0);
  float z1 = min(z0 + 1.0, G - 1.0);
  float fz = clamp(g.z - z0, 0.0, 1.0);
  vec2 xy = clamp(g.xy, 0.0, G - 1.0) + 0.5;
  vec4 a = texture(t, (tileOf(z0) * G + xy) / ATLAS);
  vec4 b = texture(t, (tileOf(z1) * G + xy) / ATLAS);
  return mix(a, b, fz);
}
vec2 field(vec3 p) { return sampleAtlas(tField, p).rg; }
// Packing over the fine grid's rest packing (zero outside its box).
float packing(vec3 p) {
  vec3 g = (p + BOXF) / (2.0 * BOXF) * GF - 0.5;
  if (min(min(g.x, g.y), g.z) < -0.5 || max(max(g.x, g.y), g.z) > GF - 0.5) return 0.0;
  float z0 = clamp(floor(g.z), 0.0, GF - 1.0);
  float z1 = min(z0 + 1.0, GF - 1.0);
  float fz = clamp(g.z - z0, 0.0, 1.0);
  vec2 xy = clamp(g.xy, 0.0, GF - 1.0) + 0.5;
  vec2 size = vec2(GF * TFX, GF * ${TFY}.0);
  float a = texture(tFine, (fineTileOf(z0) * GF + xy) / size).r;
  float b = texture(tFine, (fineTileOf(z1) * GF + xy) / size).r;
  return max(mix(a, b, fz) - fineRest, 0.0);
}
// The dye of the spores round p (packing-weighted), or -1 where there are none.
float dyeAround(vec3 p) {
  vec3 g = (p + BOXF) / (2.0 * BOXF) * GF - 0.5;
  if (min(min(g.x, g.y), g.z) < -0.5 || max(max(g.x, g.y), g.z) > GF - 0.5) return -1.0;
  float z0 = clamp(floor(g.z), 0.0, GF - 1.0);
  float z1 = min(z0 + 1.0, GF - 1.0);
  float fz = clamp(g.z - z0, 0.0, 1.0);
  vec2 xy = clamp(g.xy, 0.0, GF - 1.0) + 0.5;
  vec2 size = vec2(GF * TFX, GF * ${TFY}.0);
  vec2 v = mix(texture(tFine, (fineTileOf(z0) * GF + xy) / size).rg, texture(tFine, (fineTileOf(z1) * GF + xy) / size).rg, fz);
  return v.x > 1e-3 ? v.y / v.x : -1.0;
}
// Pressure only where the grid is over-packed; the wide density as it is.
// Engorgement: the density the mass settles to drops for a moment (it swells), more on the pulse's side of the
// colony when the pulse is lopsided.
vec3 gCentre;
float restAt(vec3 p) {
  vec3 q = p - gCentre;
  float side = smoothstep(-0.4, 0.9, dot(q, pulseDir) / max(length(q), 1e-4));
  return restDensity / (1.0 + pulseAmp * mix(1.0, side, pulseFocus));
}
float pulseSide(vec3 p) {
  vec3 q = p - gCentre;
  return mix(1.0, smoothstep(-0.4, 0.9, dot(q, pulseDir) / max(length(q), 1e-4)), pulseFocus);
}
vec2 state(vec3 p) {
  vec2 f = field(p);
  return vec2(max(f.x - restAt(p), 0.0), f.y);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  int index = texel.x + texel.y * SIZE;
  vec4 P = texelFetch(tPos, texel, 0);
  vec4 V = texelFetch(tVel, texel, 0);
  vec3 p = P.xyz;
  vec3 v = V.xyz;
  vec4 meta = texelFetch(tMeta, texel, 0);
  gCentre = centres[colonyOf(meta.x, colonies)];

  vec3 h = vec3(CELL, 0.0, 0.0);
  vec2 sx = state(p + h.xyy) - state(p - h.xyy);
  vec2 sy = state(p + h.yxy) - state(p - h.yxy);
  vec2 sz = state(p + h.yyx) - state(p - h.yyx);
  vec3 gradP = vec3(sx.x, sy.x, sz.x) / (2.0 * CELL);
  vec3 gradW = vec3(sx.y, sy.y, sz.y) / (2.0 * CELL);
  vec2 here = field(p);
  float wide = here.y;

  vec4 rest = texelFetch(tRest, texel, 0);
  vec4 health = texelFetch(tBond, texel, 0);
  vec4 st = texelFetch(tState, texel, 0);
  float age = st.x;
  float scl = st.y;
  float bud = mod(st.z, 2.0);
  float grab = floor(st.z / 2.0);
  float share = st.w;
  vec3 colonyCentre = centres[colonyOf(meta.x, colonies)];
  float sd = P.w;
  float shallow = 1.0 - smoothstep(0.3, 0.85, wide);
  vec3 outward = -gradW / max(length(gradW), 1e-4);
  float yellow = sporeClass(meta, colonies, crust);
  bool free = age >= 0.6;

  // Budding: membership is decided once, when the neck forms; cleared when the bud has come back.
  if (budMark > 0.5) bud = (!free && dot(p, budDir) > budNeck) ? 1.0 : 0.0;
  if (budClear > 0.5) bud = 0.0;
  // Grabbing: the spores near the pointer's ray, on the near side, when the drag starts.
  if (grabMark > 0.5) {
    vec3 tg = p - grabOrigin;
    float ag = dot(tg, grabDir);
    vec3 rg = tg - ag * grabDir;
    float alongG = ag - dot(colonyCentre - grabOrigin, grabDir);
    grab = (!free && dot(rg, rg) < grabRadius * grabRadius && alongG < 0.1) ? 1.0 : 0.0;
  }
  if (grabClear > 0.5) grab = 0.0;

  // A spore far from its own colony (inside another one, or between them) is in transit: it ignores the mass round
  // it (cohesion, viscosity) and heads home harder, so colonies sort themselves out instead of staying shuffled.
  float colonyR = pow(1.0 / colonies, 1.0 / 3.0);
  float transit = colonies > 1.5 ? smoothstep(colonyR * 0.9, colonyR * 1.5, length(colonyCentre - p)) : 0.0;
  // Cohesion acts at the surface (inside, the wide density's ripples would only stir it up).
  float skin = 1.0 - smoothstep(0.55, 0.9, wide);
  vec3 force = -pressure * gradP + cohesion * skin * (1.0 - transit) * gradW;
  // Collisions: spores packed tighter than grains allow push apart, from the fine grid.
  vec3 hf = vec3(CELLF, 0.0, 0.0);
  vec3 gradF = vec3(packing(p + hf.xyy) - packing(p - hf.xyy), packing(p + hf.yxy) - packing(p - hf.yxy), packing(p + hf.yyx) - packing(p - hf.yyx)) / (2.0 * CELLF);
  force -= finePressure * gradF;
  // Sorting: a gentle push toward more of its own kind (crust up the crust share, dark down it), so colours gather into
  // patches and streams that the stirring keeps tearing and folding, never fully apart.
  vec3 hs = vec3(CELLF * 1.5, 0.0, 0.0);
  float sx0 = dyeAround(p - hs.xyy), sx1 = dyeAround(p + hs.xyy);
  float sy0 = dyeAround(p - hs.yxy), sy1 = dyeAround(p + hs.yxy);
  float sz0 = dyeAround(p - hs.yyx), sz1 = dyeAround(p + hs.yyx);
  if (min(min(min(sx0, sx1), min(sy0, sy1)), min(sz0, sz1)) >= 0.0) {
    vec3 gradS = vec3(sx1 - sx0, sy1 - sy0, sz1 - sz0) / (2.0 * hs.x);
    force += sorting * (2.0 * yellow - 1.0) * gradS;
  }
  // Held near the middle; a bud's spores near the bud's own centre instead.
  // Held near its colony's centre; a bud's spores near the bud's centre; grabbed ones pulled to the pointer.
  if (grab > 0.5) {
    vec3 tgt = grabTarget - p;
    float tl = length(tgt);
    force += grabPull * tgt * min(1.0, 0.6 / max(tl, 1e-4));
  } else force += bud > 0.5 ? budPull * (budCentre - p) : centering * (colonies > 1.5 ? 2.5 + 4.0 * transit : 1.0) * (colonyCentre - p);
  // The attractor: spores within reach are drawn in, swirling round the pointer's ray.
  if (attract > 0.0) {
    vec3 ta = attractPoint - p;
    float la = length(ta);
    float wa = exp(-la * la / 0.8);
    force += attract * wa * (ta / max(la, 1e-3) + 0.6 * cross(rayDir, ta) / max(la, 1e-3));
  }

  // A growing bud: the colony bulges out along budDir, then a neck squeezes in round the axis.
  float cone = smoothstep(0.55, 0.95, dot(p, budDir) / max(length(p), 1e-4));
  force += budGrow * cone * budDir;
  float along = dot(p, budDir);
  float neck = exp(-pow((along - budNeck) / 0.18, 2.0));
  force -= budPinch * neck * (p - along * budDir);

  // Bonds to clump-mates, at the distances they started at.
  int start = int(meta.x);
  int size = int(meta.y);
  int local = index - start;
  if (size > 1) {
    int offs[4] = int[4](1, size - 1, 2, size - 2);
    for (int k = 0; k < 4; k++) {
      int j = start + (local + offs[k]) % size;
      vec3 d = texelFetch(tPos, texelOf(j), 0).xyz - p;
      float L = length(d);
      float r = rest[k];
      // A bond snaps when stretched past its rest length by more than tear, and grows back (with the same mate) while
      // the two are near again. Both ends see the same distance, so both halves snap and heal together.
      float hk = health[k];
      if (L - r > tear || free) hk = 0.0;
      else if (L < r + 0.25 * tear) hk = min(1.0, hk + heal * dt);
      health[k] = hk;
      force += bond * hk * clamp(L - r, -0.05, 0.05) * d / max(L, 1e-5);
    }
  }

  // The current: a slowly changing divergence-free stir.
  vec3 current = turbulence * curl(p * scale + offset + vec3(0.0, 0.0, flowTime));
  // The current stirs the mass; a spore that has strayed from it feels it much less, and is drawn back home.
  float inMass = smoothstep(0.15, 0.55, wide);
  force += current * mix(0.2, 1.0, inMass);
  vec3 home = (bud > 0.5 ? budCentre : colonyCentre) - p;
  if (grab < 0.5) force += recall * (1.0 - inMass) * home / max(length(home), 1e-4);

  // The pointer: a soft tube along its ray drags spores along with its motion and parts them round it.
  vec3 toP = p - rayOrigin;
  vec3 radial = toP - dot(toP, rayDir) * rayDir;
  float dr = length(radial);
  // Only the near side of the colony (the part the pointer is over), not everything down the ray.
  float alongP = dot(toP, rayDir) - dot(-rayOrigin, rayDir);
  float w = exp(-dr * dr / (pointerRadius * pointerRadius)) * (1.0 - smoothstep(-0.3, 0.2, alongP));
  vec3 push = pointerForce * w * (rayVel * 3.0 + radial / max(dr, 1e-4));
  force += push;

  // Released spores feel only the current and the pointer, and float off.
  if (free) force = current * 0.6 + push;

  float fl = length(force);
  if (fl > 30.0) force *= 30.0 / fl;
  v += force * dt;

  // A puff: spores round the clicked spot, on the near side, are blown outward in a spray (an impulse, one substep).
  if (burstStrength > 0.0) {
    vec3 tb = p - burstOrigin;
    float alongB = dot(tb, burstDir);
    vec3 rb = tb - alongB * burstDir;
    float front = 1.0 - smoothstep(-0.15, 0.25, alongB - dot(burstCentre - burstOrigin, burstDir) + 0.6);
    float wb = exp(-dot(rb, rb) / (burstRadius * burstRadius)) * front;
    vec3 jitter = vec3(hash1(sd), hash1(sd + 1.7), hash1(sd + 3.1)) - 0.5;
    vec3 dirB = normalize(normalize(p - burstCentre) - 1.2 * burstDir + 1.1 * jitter);
    v += dirB * burstStrength * wb * (0.5 + hash1(sd + 5.3));
  }

  // Fling: releasing the attractor throws what it gathered back out.
  if (fling > 0.0) {
    vec3 tf = p - attractPoint;
    float lf = length(tf);
    v += fling * exp(-lf * lf / 0.5) * normalize(tf + 0.3 * (vec3(hash1(sd + 12.1), hash1(sd + 13.3), hash1(sd + 14.7)) - 0.5));
  }

  // The crust share round the spore (eased), for its shade: crust among dark grains deepens.
  float around = dyeAround(p);
  if (around >= 0.0) share += (around - share) * (1.0 - exp(-3.0 * dt));

  // Sporulation: now and then a patch of crust round sporeDir ripens together (swells), bursts as a puff, its spores
  // drift away and shrink to nothing; then each grows back from nothing beside a clump-mate. Triggered for a single
  // substep, so nothing is released between bursts.
  if (sporeChance > 0.0 && age == 0.0 && bud < 0.5 && yellow > 0.5 && shallow > 0.6 && dot(p, sporeDir) > sporeCone * length(p) && random01(index, stepId) < sporeChance) age = 1e-4;
  if (age > 0.0) {
    float was = age;
    age += dt;
    if (age < 0.6) scl = 1.0 + 0.45 * age / 0.6;
    if (was < 0.6 && age >= 0.6) v += normalize(outward + 0.4 * (vec3(hash1(sd + 2.1), hash1(sd + 4.3), hash1(sd + 6.5)) - 0.5)) * (0.7 + 0.8 * hash1(sd + 8.7));
    if (age >= 0.6) scl = mix(1.45, 1.0, smoothstep(0.6, 1.2, age)) * (1.0 - smoothstep(2.5, 4.5, age));
    if (age > 4.5) {
      int j = start + (local + 1) % max(size, 1);
      vec3 jitter = vec3(hash1(sd + 9.1), hash1(sd + 10.3), hash1(sd + 11.7)) - 0.5;
      p = texelFetch(tPos, texelOf(j), 0).xyz + jitter * 0.02;
      v = vec3(0.0);
      age = -1.2;
      scl = 0.0;
    }
  } else if (age < 0.0) {
    age = min(age + dt, 0.0);
    scl = 1.0 + age / 1.2;
  }

  // Viscosity: each spore eases toward its neighbourhood's velocity, so the mass moves as one goo (XSPH).
  if (age < 0.6) {
    vec3 vAvg = sampleAtlas(tMomentum, p).rgb / max(here.x, 0.05);
    v = mix(v, vAvg, (1.0 - exp(-viscosity * dt)) * smoothstep(0.05, 0.3, here.x) * (1.0 - transit));
  }
  v *= exp(-(age >= 0.6 ? 0.5 : drag * dragScale) * dt);
  p += v * dt;
  // The swell itself: while a pulse fills, the mass expands from its colony's centre (more on the pulse's side), and
  // shrinks back as it sags; the lowered rest density then holds it. Radius changes ~15% per unit of pulse.
  if (age < 0.6) p += (p - gCentre) * (0.15 * pulseRate * dt * pulseSide(p));

  outPos = vec4(p, P.w);
  // How near the surface the spore sits (1 at the skin, 0 deep inside; released spores are in the open), for ambient
  // occlusion: grains deep in the mass see little of the surroundings.
  outVel = vec4(v, age >= 0.6 ? 1.0 : shallow);
  outBond = health;
  outState = vec4(age, scl, bud + 2.0 * grab, share);
}
`;

// A smooth random field in JS for the colour patches (sum of random plane waves).
function waveField(random, count, freq) {
  const waves = [];
  for (let i = 0; i < count; i++) {
    const d = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(freq * (0.7 + 0.6 * random()));
    waves.push([d.x, d.y, d.z, random() * Math.PI * 2]);
  }
  return (x, y, z) => {
    let s = 0;
    for (const [a, b, c, ph] of waves) s += Math.sin(a * x + b * y + c * z + ph);
    return s / Math.sqrt(count);
  };
}

// Clumps of 4..40 spores, scattered through a ball in random order (so any prefix of the spores is an even sample);
// each spore knows its clump (start, size), its colour-patch value, and the rest lengths of its four bonds.
function initialState(random, grain) {
  const pos = new Float32Array(MAX_SPORES * 4);
  const meta = new Float32Array(MAX_SPORES * 4);
  const rest = new Float32Array(MAX_SPORES * 4);
  // Patches a few to a side (so every view shows both colours), with a little finer variation.
  const big = waveField(random, 10, 2.8);
  const small = waveField(random, 8, 6);
  let i = 0;
  while (i < MAX_SPORES) {
    const size = Math.min(MAX_SPORES - i, Math.round(4 + 36 * Math.pow(random(), 2)));
    let cx, cy, cz, l;
    do {
      cx = random() * 2 - 1;
      cy = random() * 2 - 1;
      cz = random() * 2 - 1;
      l = Math.hypot(cx, cy, cz);
    } while (l > 1);
    const rc = grain * 1.9 * Math.cbrt(size);
    const patch = 0.5 + 0.5 * (0.85 * big(cx, cy, cz) + 0.35 * small(cx, cy, cz));
    for (let k = 0; k < size; k++) {
      let x, y, z;
      do {
        x = random() * 2 - 1;
        y = random() * 2 - 1;
        z = random() * 2 - 1;
      } while (x * x + y * y + z * z > 1);
      const n = (i + k) * 4;
      pos[n] = cx + x * rc;
      pos[n + 1] = cy + y * rc;
      pos[n + 2] = cz + z * rc;
      pos[n + 3] = random() * 1000;
      meta[n] = i;
      meta[n + 1] = size;
      meta[n + 2] = patch + (random() - 0.5) * 0.06;
      meta[n + 3] = random();
    }
    const offs = [1, size - 1, 2, size - 2];
    for (let k = 0; k < size; k++) {
      const a = (i + k) * 4;
      for (let b = 0; b < BONDS; b++) {
        const j = (i + ((k + offs[b]) % size)) * 4;
        rest[a + b] = Math.hypot(pos[j] - pos[a], pos[j + 1] - pos[a + 1], pos[j + 2] - pos[a + 2]);
      }
    }
    i += size;
  }
  const tex = (data) => {
    const t = new DataTexture(data, SIZE, SIZE, RGBAFormat, FloatType);
    t.minFilter = t.magFilter = NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  return { pos: tex(pos), meta: tex(meta), rest: tex(rest) };
}

function simTarget() {
  return new WebGLRenderTarget(SIZE, SIZE, { count: 4, type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
}
function fineTarget() {
  return new WebGLRenderTarget(GF * TFX, GF * TFY, { type: HalfFloatType, format: RGFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
}
function fieldTarget(count = 1) {
  return new WebGLRenderTarget(ATLAS, ATLAS, { count, type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
}

function createSpores(renderer, random) {
  const GRAIN = 0.011;
  const init = initialState(random, GRAIN);
  const sims = [simTarget(), simTarget()];
  const splatTarget = fieldTarget();
  const fields = [fieldTarget(2), fieldTarget(2)];
  const fine = fineTarget();
  let current = 0;

  const quadGeometry = new BufferGeometry();
  quadGeometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new Mesh(quadGeometry);
  quad.frustumCulled = false;
  const quadScene = new Scene();
  quadScene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pass = (material, target) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, camera);
  };
  const raw = (fragmentShader, uniforms, extra = {}) =>
    new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: quadVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: NoBlending, ...extra });

  const coloniesUniform = { value: 1 };
  // Positions at the start of the frame, for motion vectors.
  const posTarget = () => new WebGLRenderTarget(SIZE, SIZE, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  // Drawn positions sit between the last two simulation steps (so a slow simulation still moves smoothly): the
  // positions at the start of the latest step, and the drawn positions of this frame and the last (motion vectors).
  const stepStart = posTarget();
  const shown = [posTarget(), posTarget()];
  let shownCurrent = 0;
  let shownFresh = true;
  let stepStartRows = 0;
  let shownRows = 0;
  const lastFrame = shown[1];
  // Per-grain lighting, ping-ponged so each frame eases from the last.
  const lightTargets = [0, 1].map(() => new WebGLRenderTarget(SIZE, SIZE, { type: HalfFloatType, format: RGFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false }));
  let lightCurrent = 0;
  let lightFresh = true;
  let lightRows = 0;
  const g = globalUniforms;
  const lightMaterial = raw(lightFragment, {
    tPos: { value: null },
    tPrev: { value: null },
    colonyMatrix: { value: null },
    lightDirection: g.lightDirection,
    shadowMap: g.shadowMap,
    shadowMapCmp: g.shadowMapCmp,
    shadowMatrix: g.shadowMatrix,
    shadowMapSize: g.shadowMapSize,
    shadowEnabled: g.shadowEnabled,
    radius: { value: 0.01 },
    translucency: { value: 0.5 },
    blend: { value: 1 },
  });
  const lerpMaterial = raw(
    "precision highp float; uniform sampler2D tA; uniform sampler2D tB; uniform float alpha; out vec4 outColor; void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec4 b = texelFetch(tB, c, 0); outColor = vec4(mix(texelFetch(tA, c, 0).xyz, b.xyz, alpha), b.w); }",
    { tA: { value: null }, tB: { value: null }, alpha: { value: 1 } },
  );
  const copyMaterial = raw(
    "precision highp float; uniform sampler2D tSource; out vec4 outColor; void main() { outColor = texelFetch(tSource, ivec2(gl_FragCoord.xy), 0); }",
    { tSource: { value: null } },
  );
  const initMaterial = raw(initFragment, { tInitPos: { value: init.pos }, tMeta: { value: init.meta }, colonies: coloniesUniform });

  const splatUniforms = { tPos: { value: null }, tVel: { value: null }, sliceOffset: { value: 0 }, weight: { value: 1 } };
  const splatMaterial = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: splatVertex,
    fragmentShader: splatFragment,
    uniforms: splatUniforms,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  const splatGeometry = new BufferGeometry();
  // Only the count matters (gl_VertexID picks the spore); three needs an attribute to size the draw.
  splatGeometry.setAttribute("position", new BufferAttribute(new Float32Array(MAX_SPORES * 3), 3));
  const splatPoints = new Points(splatGeometry, splatMaterial);
  splatPoints.frustumCulled = false;
  const splatScene = new Scene();
  splatScene.add(splatPoints);

  const fineUniforms = { tPos: { value: null }, tState: { value: null }, grainVolume: { value: 0 }, tMeta: { value: init.meta }, colonies: coloniesUniform, crust: { value: 0.5 } };
  const fineMaterial = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: fineSplatVertex,
    fragmentShader: fineSplatFragment,
    uniforms: fineUniforms,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  // Two points per spore (one per z slice), instanced by spore.
  const fineGeometry = new InstancedBufferGeometry();
  fineGeometry.setAttribute("position", new BufferAttribute(new Float32Array(2 * 3), 3));
  const finePoints = new Points(fineGeometry, fineMaterial);
  finePoints.frustumCulled = false;
  const fineScene = new Scene();
  fineScene.add(finePoints);

  const blurUniforms = { tDensity: { value: null }, tMomentum: { value: null }, axis: { value: new Vector3() }, first: { value: 0 } };
  const blurMaterial = raw(blurFragment, blurUniforms);

  const simUniforms = {
    tPos: { value: null },
    tVel: { value: null },
    tField: { value: null },
    tMomentum: { value: null },
    viscosity: { value: 12 },
    tMeta: { value: init.meta },
    tRest: { value: init.rest },
    dt: { value: 0 },
    time: { value: 0 },
    flowTime: { value: 0 },
    offset: { value: new Vector3() },
    turbulence: { value: 1.1 },
    scale: { value: 1 },
    pressure: { value: 8 },
    cohesion: { value: 6 },
    bond: { value: 60 },
    drag: { value: 1.5 },
    dragScale: { value: 1 },
    centering: { value: 1.5 },
    rayOrigin: { value: new Vector3(0, 0, 100) },
    rayDir: { value: new Vector3(0, 0, -1) },
    rayVel: { value: new Vector3() },
    pointerRadius: { value: 0.25 },
    pointerForce: { value: 0 },
    tBond: { value: null },
    tear: { value: 0.04 },
    heal: { value: 0.5 },
    restDensity: { value: 1 },
    pulseAmp: { value: 0 },
    pulseDir: { value: new Vector3(0, 1, 0) },
    pulseFocus: { value: 0 },
    pulseRate: { value: 0 },
    burstOrigin: { value: new Vector3() },
    burstDir: { value: new Vector3(0, 0, -1) },
    burstCentre: { value: new Vector3() },
    burstStrength: { value: 0 },
    burstRadius: { value: 0.3 },
    tFine: { value: fine.texture },
    finePressure: { value: 1.5 },
    fineRest: { value: 0.35 },
    tState: { value: null },
    crust: { value: 0.5 },
    sporeDir: { value: new Vector3(0, 1, 0) },
    sporeCone: { value: 0.98 },
    sporeChance: { value: 0 },
    stepId: { value: 0 },
    budDir: { value: new Vector3(1, 0, 0) },
    budCentre: { value: new Vector3() },
    budNeck: { value: 0.6 },
    budGrow: { value: 0 },
    budPinch: { value: 0 },
    budPull: { value: 3 },
    budMark: { value: 0 },
    budClear: { value: 0 },
    recall: { value: 12 },
    sorting: { value: 0.6 },
    colonies: coloniesUniform,
    centres: { value: [new Vector3(), new Vector3(), new Vector3()] },
    grabOrigin: { value: new Vector3() },
    grabDir: { value: new Vector3(0, 0, -1) },
    grabRadius: { value: 0.22 },
    grabMark: { value: 0 },
    grabClear: { value: 0 },
    grabTarget: { value: new Vector3() },
    grabPull: { value: 0 },
    attractPoint: { value: new Vector3() },
    attract: { value: 0 },
    fling: { value: 0 },
  };
  // The fine splat classes spores with the same crust threshold.
  fineUniforms.crust = simUniforms.crust;
  const updateMaterial = raw(updateFragment, simUniforms);

  // Impostor spheres: one camera-facing quad each, shaded as a sphere (an 80-triangle sphere a few pixels wide is all
  // sub-pixel triangles, which the rasterizer handles very badly).
  const quadShape = new PlaneGeometry(2, 2);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quadShape.index;
  for (const name of ["position", "normal", "uv"]) geometry.setAttribute(name, quadShape.getAttribute(name));
  geometry.instanceCount = 1;
  // The simulation box, so the shadow auto-fit frames every spore rather than the template quad.
  geometry.boundingSphere = new Sphere(new Vector3(), BOX * Math.SQRT2);

  const uniforms = {
    tPos: { value: null },
    tVel: { value: null },
    tMeta: { value: init.meta },
    tState: { value: null },
    sporeSize: { value: GRAIN },
    microscope: { value: 0 },
    tLastFrame: { value: null },
    tLight: { value: lightTargets[0].texture },
    moved: { value: 0 },
    shutter: { value: 0.5 },
    ornament: { value: 1 },
    detail: { value: 0.6 },
    translucency: { value: 0.5 },
    colonies: coloniesUniform,
    crust: { value: 0.5 },
    crustColor: { value: new Color("#f2b10c") },
    crustColor2: { value: new Color("#e8780a") },
    coreColor: { value: new Color("#0d0c0b") },
    prevCrustColor: { value: new Color("#f2b10c") },
    prevCrustColor2: { value: new Color("#e8780a") },
    prevCoreColor: { value: new Color("#0d0c0b") },
    prevCrust: { value: 0.5 },
    prevSize: { value: GRAIN },
    prevColonies: { value: 1 },
    colonyAge: { value: 100 },
    changeAge: { value: 100 },
    crustRough: { value: 0.68 },
    coreRough: { value: 0.55 },
  };
  const material = new PipelineMaterial({
    uniforms,
    varyings: { vSpore: "vec4", vQuad: "vec2", vAxis: "vec3", vPix: "float", vColony: "float", vLit: "float", vThrough: "float", vChange: "float", vColonyPrev: "float", vColonyChange: "float" },
    vertexPars: /* glsl */ `
      uniform sampler2D tPos;
      uniform sampler2D tVel;
      uniform sampler2D tMeta;
      uniform sampler2D tState;
      uniform float sporeSize;
      // Per grain: (key light at its lit side, light scattered through the mass to it), from the light pass.
      uniform sampler2D tLight;
      uniform float crust;
      // The look before the last change, and seconds since it.
      uniform float prevCrust;
      uniform float prevSize;
      uniform float prevColonies;
      uniform float colonyAge;
      uniform float changeAge;
      uniform float colonies;
      uniform float microscope;
      uniform float detail;
      uniform float translucency;
      uniform vec2 resolution;
      // Last frame's positions (moved = 0: nothing stepped this frame), and the fraction of the frame the shutter is
      // open (0.5 = 180 degrees).
      uniform sampler2D tLastFrame;
      uniform float moved;
      uniform float shutter;
      uniform float motionPass;
      float sporeHash(float n) { return fract(sin(n * 78.233) * 43758.5453); }
    `,
    vertex: /* glsl */ `
      vec3 displace(vec3 p, inout vec3 n) {
        ivec2 c = ivec2(gl_InstanceID % ${SIZE}, gl_InstanceID / ${SIZE});
        vec4 d = texelFetch(tPos, c, 0);
        vec4 meta = texelFetch(tMeta, c, 0);
        float h = sporeHash(float(gl_InstanceID) * 0.618);
        // A new colony's look reaches each spore on its own schedule: a start shared loosely by its clump, its own
        // offset and its own pace, so the change spreads through the mass in patches instead of all at once.
        float delay = 0.8 * fract(sin(mod(meta.x, 911.0) * 0.731 + 0.4) * 43758.5453) + 0.9 * fract(h * 13.7 + 0.3);
        float change = smoothstep(delay, delay + 0.5 + 0.9 * fract(h * 7.9 + 0.6), changeAge);
        float th = mix(1.05, -0.05, mix(prevCrust, crust, change));
        // A spore's class (dark or crust) is its own and never changes: its patch, shifted by its colony (as in the
        // simulation's baseDye). Colours mix by grains moving among each other; the mixed dye only tints the crust.
        float colony = min(floor(fract(sin(mod(meta.x, 977.0) * 0.1271 + 1.7) * 43758.5453) * colonies), colonies - 1.0);
        float base = meta.z;
        float yellow = smoothstep(-0.08, 0.08, base - th);
        float share = texelFetch(tState, c, 0).w;
        // Crust grains a little larger than the dark ones under them; every spore its own size.
        float scl = texelFetch(tState, c, 0).y;
        float s = mix(prevSize, sporeSize, change) * (0.7 + 0.6 * h) * mix(0.95, 1.05, yellow) * scl;
        // Previous pose: last frame's for the velocity that reprojects AO/GI; for motion blur, the last move scaled by
        // the shutter and capped near a grain's length so fast grains soften instead of drawing hairs (halved: the
        // blur smears from -v to +v).
        if (pipelinePrevPose) {
          vec3 m = texelFetch(tLastFrame, c, 0).xyz - d.xyz;
          if (motionPass > 0.5) {
            m *= clamp(shutter, 0.0, 1.0);
            d.xyz += m * min(1.0, 2.0 * s / max(length(m), 1e-6)) * 0.5;
          } else d.xyz += m * moved;
        }
        if (!pipelinePrevPose) {
          float shallowness = texelFetch(tVel, c, 0).w;
          // Crust shade: the spore's own, deepened where it sits among dark grains.
          vSpore = vec4(yellow, clamp(0.6 * meta.w + 0.8 * (1.0 - share) - 0.15, 0.0, 1.0), h, shallowness);
          vQuad = p.xy;
        }
        // Spores are a little oval, each along its own axis (seen in the view plane, which is enough at this size); more
        // so under the microscope.
        float elong = 1.0 + detail * (0.12 + 0.3 * fract(h * 3.7)) + 0.5 * microscope;
        float ang = 6.2831853 * fract(h * 7.31 + meta.w);
        vec2 ax = vec2(cos(ang), sin(ang));
        vec2 perp = vec2(-ax.y, ax.x);
        vec2 qs = ax * dot(p.xy, ax) * elong + perp * dot(p.xy, perp);
        // The view's axes in object space (the colony spins, the camera orbits).
        mat3 toObject = transpose(mat3(modelMatrix));
        vec3 right = toObject * vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = toObject * vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 back = toObject * vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        // Geometric normal bulged like the sphere: PipelineMaterial gates the key by step(dot(N, L)) on it.
        n = normalize(right * p.x + up * p.y + back * 0.5);
        vec3 centre = d.xyz;
        vec4 viewPos = viewMatrix * modelMatrix * vec4(d.xyz, 1.0);
        float pix = s * projectionMatrix[1][1] * resolution.y * 0.5 / max(-viewPos.z, 1e-3);
      #ifndef PIPELINE_SHADOW
        // Seen by the camera, the quad sits on the sphere's front, so neighbours overlap in the right order and the
        // shadow lookup lands near the surface. The light's view keeps it through the centre, so each grain shadows
        // its own far side only.
        centre += back * s;
      #endif
        if (!pipelinePrevPose) {
          vAxis = vec3(ax, elong);
          vColony = colonies < 1.5 ? -1.0 : colony;
          // Its colony under the count before the last change, for its colour to change from.
          float colonyPrev = min(floor(fract(sin(mod(meta.x, 977.0) * 0.1271 + 1.7) * 43758.5453) * prevColonies), prevColonies - 1.0);
          vColonyPrev = prevColonies < 1.5 ? -1.0 : colonyPrev;
          vColonyChange = smoothstep(delay, delay + 0.5 + 0.9 * fract(h * 7.9 + 0.6), colonyAge);
        #ifndef PIPELINE_SHADOW
          vec2 light = texelFetch(tLight, c, 0).rg;
          vLit = light.r;
          vThrough = light.g;
        #endif
          // The grain's radius in pixels, to fade out surface detail it is too small to show.
          vPix = pix;
          vChange = change;
        }
        return centre + (right * qs.x + up * qs.y) * s;
      }
    `,
    fragmentPars: /* glsl */ `
      uniform vec3 crustColor;
      uniform vec3 crustColor2;
      uniform vec3 coreColor;
      uniform vec3 prevCrustColor;
      uniform vec3 prevCrustColor2;
      uniform vec3 prevCoreColor;
      uniform float crustRough;
      uniform float coreRough;
      uniform float microscope;
      uniform float ornament;
      uniform float detail;
      uniform float translucency;
      // A crust grain's colour by its colony (-1: one colony, shading between the palette's two crust colours).
      vec3 colonyCrust(float colony, vec3 c1, vec3 c2, float shade) {
        if (colony < -0.5) return mix(c1, c2, shade);
        // The third colony: halfway between the two crust colours, pushed more saturated (never toward white).
        vec3 mid = mix(c1, c2, 0.5);
        vec3 own = colony < 0.5 ? c1 : colony < 1.5 ? c2 : mix(vec3(dot(mid, vec3(0.2126, 0.7152, 0.0722))), mid, 1.5);
        return mix(own, own * 0.6, shade);
      }
      vec3 sporeHash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }
      // Cellular distances (F1, F2) over the grain's surface: ridges along cell borders make a reticulate net, small
      // domes at cell centres make spines.
      vec2 sporeCells(vec3 p) {
        vec3 i = floor(p);
        vec3 f = p - i;
        float f1 = 9.0, f2 = 9.0;
        for (int z = -1; z <= 1; z++)
        for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec3 o = vec3(x, y, z);
          vec3 r = o + sporeHash33(i + o) - f;
          float d = dot(r, r);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        return sqrt(vec2(f1, f2));
      }
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        float r2 = dot(vQuad, vQuad);
        if (r2 > 1.0) discard;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        // The sphere's normal, squashed along the grain's long axis (an ellipsoid).
        vec2 ax = vAxis.xy;
        vec2 perp = vec2(-ax.y, ax.x);
        vec2 n2 = ax * (dot(vQuad, ax) / vAxis.z) + perp * dot(vQuad, perp);
        float nz = sqrt(1.0 - r2);
        s.normal = normalize(right * n2.x + up * n2.y + back * nz);
        float c = vSpore.x;
        // The grain's surface ornament (a net on crust grains, spines on the dark ones, and a furrow along the crust
        // grain's length), as a bump where the grain is big enough to show it; strongest under the microscope.
        float relief = 0.0;
        float furrow = 0.0;
        float bump = max(microscope, 0.8 * detail) * ornament * smoothstep(4.0, 9.0, vPix);
        // Only where a grain is big enough on screen to show it (it's the costliest part of the shading).
        if (bump > 0.02) {
          float a = 6.2831853 * vSpore.z;
          vec3 local = vec3(n2.x * cos(a) - n2.y * sin(a), n2.x * sin(a) + n2.y * cos(a), nz);
          vec2 cells = sporeCells(local * 3.2 + vSpore.zyx * 17.0);
          float net = 1.0 - smoothstep(0.02, 0.12, cells.y - cells.x);
          float spines = 1.0 - smoothstep(0.0, 0.22, cells.x);
          relief = vSpore.y > 0.5 ? net : spines;
          furrow = c * (1.0 - smoothstep(0.03, 0.14, abs(dot(n2, perp)))) * smoothstep(0.0, 0.3, nz);
          float h = relief - 1.5 * furrow;
          vec2 dh = vec2(dFdx(h), dFdy(h));
          s.normal = normalize(s.normal - (right * dh.x + up * dh.y) * 0.5 * bump);
        }
        // Crust grains range from the light colour to the deep one.
        // One colony: its crust shades between the palette's two crust colours. Several: each colony's crust is its own
        // colour (main, deep, pale), shading toward a deeper version of it; the dark grains are the same in all.
        vec3 cCrust = mix(prevCrustColor, crustColor, vChange);
        vec3 cCrust2 = mix(prevCrustColor2, crustColor2, vChange);
        vec3 cCore = mix(prevCoreColor, coreColor, vChange);
        float shade = vSpore.y * vSpore.y;
        vec3 crustAlbedo = mix(colonyCrust(vColonyPrev, cCrust, cCrust2, shade), colonyCrust(vColony, cCrust, cCrust2, shade), vColonyChange);
        // The shade variation leans a little more saturated as it deepens.
        float luma = dot(crustAlbedo, vec3(0.2126, 0.7152, 0.0722));
        crustAlbedo = max(mix(vec3(luma), crustAlbedo, 1.0 + 0.35 * shade), 0.0);
        s.albedo = mix(cCore * (0.7 + 0.6 * vSpore.y), crustAlbedo, c);
        s.roughness = mix(coreRough, crustRough, c);
        s.specular = mix(0.35, 0.6, c);
        // Ambient occlusion from depth in the mass: grains under others see little of the surroundings.
        s.occlusion = mix(0.3, 1.0, vSpore.w);
        // Grains are packed: toward a grain's edge (seen edge-on) its reflection and skylight come from its neighbours,
        // not the bright surroundings, so the edge is occluded. Without this every small sphere gets a bright Fresnel
        // ring and the dark grains look outlined in white.
        s.occlusion *= mix(0.15, 1.0, smoothstep(0.05, 0.6, dot(s.normal, back)));
        s.occlusion *= 1.0 - 0.5 * furrow * bump;
        // Translucency, mostly in the waxy crust grains: the key comes through grains lit from behind (the material's
        // transmission), wraps a little past each grain's terminator, and scatters on through the mass (vThrough),
        // glowing deep and saturated, most when the view looks toward the light.
        float tr = translucency * mix(0.15, 1.0, c);
        s.transmission = vec3(0.7 * tr);
      #if !defined(PIPELINE_SHADOW) && !defined(PIPELINE_PREPASS)
        float ndl = dot(s.normal, lightDirection);
        float wrap = max((ndl + 0.5) / 1.5, 0.0) - max(ndl, 0.0);
        float rim = 1.0 - max(dot(s.normal, back), 0.0);
        // Light scattered on through the mass: some in every direction, much more looking toward the light.
        float forward = pow(max(dot(-back, lightDirection), 0.0), 2.0) * (0.5 + 0.5 * rim);
        vec3 deep = s.albedo * s.albedo * 2.2;
        s.emissive += lightColor * tr * deep * (0.5 * wrap * vLit + vThrough * (0.08 * (1.0 - 0.85 * vLit) + 2.5 * forward)) / 3.14159;
      #endif
      #ifndef PIPELINE_SHADOW
        s.shadow = vLit;
      #endif
        // Electron microscope: grey, matte, and bright where the beam grazes (edges and ridges give off the most
        // electrons), so form reads from edges rather than from the light.
        if (microscope > 0.0) {
          float m = microscope;
          float edge = pow(1.0 - max(dot(s.normal, back), 0.0), 2.0);
          s.albedo = mix(s.albedo, vec3(mix(0.12, 0.18, c)), m);
          s.roughness = mix(s.roughness, 0.9, m);
          s.specular = mix(s.specular, 0.3, m);
          s.emissive = mix(s.emissive, vec3(0.45 * edge + 0.12 * relief * bump), m);
        }
      }
    `,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  let started = false;
  function start() {
    for (const t of sims) {
      t.scissorTest = false;
      pass(initMaterial, t);
    }
    started = true;
  }

  const copyRows = (source, target, rows) => {
    copyMaterial.uniforms.tSource.value = source;
    target.scissor.set(0, 0, SIZE, rows);
    target.scissorTest = true;
    pass(copyMaterial, target);
  };
  // The positions to draw this frame: alpha (0..1) of the way from the start of the latest step to its end. Call once per
  // rendered frame, after its steps; advancing false (paused) keeps last frame's, so a frozen frame keeps its blur.
  function interpolate(alpha, advancing) {
    if (!started) return;
    const rows = Math.min(SIZE, Math.ceil(geometry.instanceCount / SIZE));
    const prevTarget = renderer.getRenderTarget();
    // Grains just added have no step history yet: they start where they are.
    if (rows > stepStartRows) {
      copyRows(sims[current].textures[0], stepStart, rows);
      stepStartRows = rows;
    }
    // More grains drawn than last frame (even paused): draw them all from the current state.
    if (rows > shownRows) shownFresh = true;
    shownRows = rows;
    if (advancing || shownFresh) {
      lerpMaterial.uniforms.tA.value = stepStart.texture;
      lerpMaterial.uniforms.tB.value = sims[current].textures[0];
      lerpMaterial.uniforms.alpha.value = Math.min(1, Math.max(0, alpha));
      shownCurrent = 1 - shownCurrent;
      shown[shownCurrent].scissor.set(0, 0, SIZE, rows);
      shown[shownCurrent].scissorTest = true;
      pass(lerpMaterial, shown[shownCurrent]);
      if (shownFresh) copyRows(shown[shownCurrent].texture, shown[1 - shownCurrent], rows);
      shownFresh = false;
    }
    renderer.setRenderTarget(prevTarget);
    uniforms.moved.value = advancing ? 1 : 0;
    uniforms.tPos.value = shown[shownCurrent].texture;
    uniforms.tLastFrame.value = shown[1 - shownCurrent].texture;
  }


  // Lights every grain from the current shadow map (last frame's, as this runs before the pipeline renders: a frame
  // behind, which the easing hides). Call once per rendered frame, after the steps.
  function updateLight() {
    if (!started) return;
    const u = lightMaterial.uniforms;
    mesh.updateMatrixWorld();
    u.tPos.value = uniforms.tPos.value;
    u.tPrev.value = lightTargets[lightCurrent].texture;
    u.colonyMatrix.value = mesh.matrixWorld;
    u.radius.value = uniforms.sporeSize.value;
    u.translucency.value = uniforms.translucency.value;
    // Grains just added have no history: take this frame's light outright.
    const rows = Math.min(SIZE, Math.ceil(geometry.instanceCount / SIZE));
    u.blend.value = lightFresh || rows > lightRows || !g.shadowMap.value ? 1 : 0.35;
    lightFresh = false;
    lightRows = rows;
    lightCurrent = 1 - lightCurrent;
    const t = lightTargets[lightCurrent];
    t.scissor.set(0, 0, SIZE, rows);
    t.scissorTest = true;
    const prevTarget = renderer.getRenderTarget();
    pass(lightMaterial, t);
    renderer.setRenderTarget(prevTarget);
    uniforms.tLight.value = t.texture;
  }

  // Advances the simulation by dt (substeps share one density grid). dt = 0 (paused) leaves it as it is.
  function step(dt, time, flowTime, substeps = SUBSTEPS) {
    const grain = uniforms.sporeSize.value;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (!started) start();
    const count = geometry.instanceCount;
    const rows = Math.min(SIZE, Math.ceil(count / SIZE));
    if (dt > 0) {
      copyRows(sims[current].textures[0], stepStart, rows);
      stepStartRows = rows;
      // 1. Density.
      splatUniforms.tPos.value = sims[current].textures[0];
      splatUniforms.tVel.value = sims[current].textures[1];
      splatUniforms.weight.value = VOLUME / (count * CELL * CELL * CELL);
      splatGeometry.setDrawRange(0, count);
      renderer.setRenderTarget(splatTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      for (const slice of [0, 1]) {
        splatUniforms.sliceOffset.value = slice;
        renderer.render(splatScene, camera);
      }
      // Fine packing (collisions).
      fineUniforms.tPos.value = sims[current].textures[0];
      fineUniforms.tState.value = sims[current].textures[3];
      fineUniforms.grainVolume.value = ((4 / 3) * Math.PI * grain ** 3) / CELLF ** 3;
      fineGeometry.instanceCount = count;
      renderer.setRenderTarget(fine);
      renderer.clear();
      renderer.render(fineScene, camera);
      // 2. Blur along x, y, z: splat -> fields[0] -> [1] -> [0].
      const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
      axes.forEach((a, i) => {
        blurUniforms.tDensity.value = i === 0 ? splatTarget.texture : fields[(i + 1) % 2].textures[0];
        blurUniforms.tMomentum.value = i === 0 ? splatTarget.texture : fields[(i + 1) % 2].textures[1];
        blurUniforms.axis.value.copy(a);
        blurUniforms.first.value = i === 0 ? 1 : 0;
        pass(blurMaterial, fields[i % 2]);
      });
      simUniforms.tField.value = fields[0].textures[0];
      simUniforms.tMomentum.value = fields[0].textures[1];
      // 3. Forces and motion.
      const h = Math.min(dt, 1 / 30) / substeps;
      simUniforms.dragScale.value = substeps === 1 ? ONE_PASS_DRAG : 1;
      simUniforms.dt.value = h;
      simUniforms.time.value = time;
      simUniforms.flowTime.value = flowTime;
      for (let i = 0; i < substeps; i++) {
        simUniforms.tPos.value = sims[current].textures[0];
        simUniforms.tVel.value = sims[current].textures[1];
        simUniforms.tBond.value = sims[current].textures[2];
        simUniforms.tState.value = sims[current].textures[3];
        simUniforms.stepId.value = (simUniforms.stepId.value + 1) % 4096;
        current = 1 - current;
        sims[current].scissor.set(0, 0, SIZE, rows);
        sims[current].scissorTest = true;
        pass(updateMaterial, sims[current]);
        simUniforms.burstStrength.value = 0;
        simUniforms.budMark.value = 0;
        simUniforms.sporeChance.value = 0;
        simUniforms.grabMark.value = 0;
        simUniforms.grabClear.value = 0;
        simUniforms.fling.value = 0;
        simUniforms.budClear.value = 0;
      }
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    uniforms.tVel.value = sims[current].textures[1];
    uniforms.tState.value = sims[current].textures[3];

  }

  return {
    mesh,
    material,
    uniforms,
    simUniforms,
    step,
    interpolate,
    updateLight,
    reset: () => (started = false),
    // For debugging: the current simulation target (textures: position, velocity) and the density atlas.
    get simTarget() {
      return sims[current];
    },
    fields,
    splatTarget,
    lastFrame,
    fine,
    set count(n) {
      geometry.instanceCount = Math.max(1, Math.min(MAX_SPORES, Math.round(n)));
    },
    get count() {
      return geometry.instanceCount;
    },
  };
}

export { createSpores, MAX_SPORES };
