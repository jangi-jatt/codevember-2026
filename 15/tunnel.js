// The neon tunnel the card dashes through: a tube along -z that winds away ahead (straight at the card, bending more
// the further down it) and slowly rolls, its wall in a run of neon styles, one a section. Toward each section's end the
// next one comes in over it piece by piece, and the tube's shape blends into the next one's. Its live image is what the
// glass and foil reflect.
import { Mesh, Scene, CylinderGeometry, ShaderMaterial, BackSide, PMREMGenerator, Vector3, Color, GLSL3 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { applyEnvironment, computeSH } from "modules/pipeline/studio.js";
import { RADIUS, BLEND, SECTION_GLSL as section, WALL_GLSL as wall } from "./tunnelWall.js";

export const TUNNEL_STYLES = ["tiles", "rings", "hex", "grid", "laser", "memphis", "suns"];
const NEAR = 400;
const FAR = -260;

const SECTION = 140;
// The rings' spacing (4 lanes' widths): with the music, a whole number of them pass the card each beat.
const RING_SPACING = (4 * 2 * Math.PI * RADIUS) / 24;

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

// The tunnel as a glossy surface reflects it: the reflected ray met with the tube (its bend followed in a few steps)
// and the wall drawn there, widened by the surface's roughness and smeared by its streaming as the tunnel itself is.
// pixelAngle: a screen pixel's angular size.
export const TUNNEL_TRACE_GLSL = /* glsl */ `
uniform float tunnelTravel;
uniform float tunnelBend;
uniform float tunnelTime;
uniform float tunnelPixelAngle;
uniform float tunnelBlurLen;
${wall}
vec2 tCurveT(float s) {
  return vec2(sin(s * 0.021) + 0.6 * sin(s * 0.037 + 2.0), 0.8 * sin(s * 0.017 + 1.0) + 0.4 * sin(s * 0.043)) * 18.0;
}
vec2 tSlopeT(float s) {
  return vec2(0.021 * cos(s * 0.021) + 0.0222 * cos(s * 0.037 + 2.0), 0.0136 * cos(s * 0.017 + 1.0) + 0.0172 * cos(s * 0.043)) * 18.0;
}
vec2 tOffset(float d) {
  return (tCurveT(tunnelTravel + d) - tCurveT(tunnelTravel) - tSlopeT(tunnelTravel) * d) * tunnelBend;
}
// How far outside the bent tube's wall the ray is, t along it (negative inside).
float tOutside(vec3 P, vec3 R, float t) {
  vec3 X = P + R * t;
  return length(X.xy - tOffset(-X.z)) - RADIUS_T;
}
vec3 traceTunnel(vec3 P, vec3 R, float rough) {
  // The straight tube's hit to start from, then bracketed and bisected against the bent one (the bend grows with
  // distance, so far down the tube the straight hit can be well off).
  float A = dot(R.xy, R.xy);
  float B = dot(P.xy, R.xy), C = dot(P.xy, P.xy) - RADIUS_T * RADIUS_T;
  float hi = A > 1e-6 ? (-B + sqrt(max(B * B - A * C, 0.0))) / A : 400.0;
  hi = min(hi, 400.0);
  float lo = 0.0;
  for (int i = 0; i < 4; i++) {
    if (tOutside(P, R, hi) > 0.0) break;
    lo = hi;
    hi *= 2.0;
  }
  for (int i = 0; i < 7; i++) {
    float m = 0.5 * (lo + hi);
    if (tOutside(P, R, m) > 0.0) hi = m;
    else lo = m;
  }
  // Exact against the circle the bend puts there (it changes slowly along the tube).
  vec2 off = tOffset(-(P.z + R.z * hi));
  vec2 o = P.xy - off;
  B = dot(o, R.xy);
  C = dot(o, o) - RADIUS_T * RADIUS_T;
  float t = A > 1e-6 ? (-B + sqrt(max(B * B - A * C, 0.0))) / A : hi;
  vec3 H = P + R * t;
  vec2 q = H.xy - off;
  // A pixel's footprint there (from the camera, by way of the glass), stretched along the tube where the ray meets the
  // wall at a glance; and blurred more the further it reaches, fading the far wall to its average as the tunnel's own
  // distance does.
  // Never less than the hit's own change from pixel to pixel, which catches how far down the tube the wall foreshortens.
  float w = (length(P - cameraPosition) + t) * tunnelPixelAngle;
  float across = abs(dot(R.xy, normalize(q)));
  float a = atan(q.y, q.x), s = tunnelTravel - H.z;
  float da = max(w / RADIUS_T, tAngleWidth(a)), ds = max(w / max(across, 0.05), fwidth(s));
  float blur = t * rough * rough * 1.5 + max(t - 12.0, 0.0) * 0.03;
  return tunnelBlendAt(a, s, -H.z, blur, da, ds, tunnelBlurLen) * tunnelLight;
}
`;

function tube(radial, rings) {
  const geometry = new CylinderGeometry(RADIUS, RADIUS, NEAR - FAR, radial, rings, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, (NEAR + FAR) / 2);
  return geometry;
}

// The styles from least to most going on: sparse rings, laser lanes, the grid, retro suns, the hex hall, the dense tiles,
// Memphis shapes.
export const TUNNEL_BY_INTENSITY = ["rings", "laser", "grid", "suns", "hex", "tiles", "memphis"];
// How far ahead of the card a new style starts coming in (metres).
const AHEAD = 50;

export function createTunnel(renderer) {
  const uniforms = {
    tunnelTravel: { value: 0 },
    tunnelBend: { value: 1 },
    tunnelTime: { value: 0 },
    tunnelStreaks: { value: 0 },
    tunnelDots: { value: 0 },
    tunnelAutoPulse: { value: 1 },
    tunnelFrom: { value: 0 },
    tunnelTo: { value: 0 },
    tunnelGate: { value: -1e9 },
    tunnelBeats: { value: 0 },
    tunnelHat: { value: 0 },
    tunnelGain: { value: 1 },
    tunnelKickN: { value: 0 },
    tunnelHatN: { value: 0 },
    tunnelLight: { value: 1 },
    tunnelKick: { value: 0 },
    tunnelWaveS: { value: -1e4 },
    tunnelWaveAmp: { value: 0 },
    tunnelBlurLen: { value: 0 },
    tunnelCardRing: { value: 0 },
    tunnelPixelAngle: { value: 0.001 },
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
        s.emissive = tunnelBlendMoving(atan(vTube.y, vTube.x), vTube.z, vTube.z - tunnelTravel, tunnelBlurLen) * tunnelLight;
      }
    `,
  });
  const mesh = new Mesh(tube(192, 500), material);
  mesh.userData.noShadow = true;
  mesh.userData.noWireframe = true;
  mesh.frustumCulled = false;

  const env = createEnvironmentBaker(renderer);
  let envStyle = -1;
  return {
    mesh,
    env,
    uniforms,
    // speed: metres a second.
    // streaks, dots: the overlays' strengths (0..1), eased to.
    // shutter: seconds of motion blur along the tunnel (0 for none).
    // bpm: with the music, its tempo; the speed then snaps to the nearest whole number of rings a beat, and the travel is
    // eased into phase with tunnelBeats so a ring passes the card on every beat.
    update(dt, speed, bendAmount = 1, { streaks = 0, dots = 0, shutter = 0, bpm = 0 } = {}) {
      const u = uniforms;
      const k = 1 - Math.exp(-2 * dt);
      u.tunnelStreaks.value += (streaks - u.tunnelStreaks.value) * k;
      u.tunnelDots.value += (dots - u.tunnelDots.value) * k;
      if (bpm > 0 && this.beatsFromMusic) {
        const perBeat = RING_SPACING * (bpm / 60);
        const rings = Math.max(1, Math.round(speed / perBeat));
        speed = rings * perBeat;
        // Phase error in rings, wrapped to -0.5..0.5.
        const phase = u.tunnelTravel.value / RING_SPACING - u.tunnelBeats.value * rings;
        const err = phase - Math.round(phase);
        u.tunnelTravel.value += dt * speed - err * RING_SPACING * (1 - Math.exp(-4 * dt));
      } else u.tunnelTravel.value += dt * speed;
      this.speed = speed;
      u.tunnelBlurLen.value = speed * shutter;
      u.tunnelTime.value += dt;
      if (!this.beatsFromMusic) u.tunnelBeats.value += dt * (130 / 60);
      const beatIndex = Math.floor(u.tunnelBeats.value);
      if (beatIndex !== this.beatIndex) {
        this.beatIndex = beatIndex;
        u.tunnelCardRing.value = Math.round(u.tunnelTravel.value / RING_SPACING);
      }
      u.tunnelBend.value = bendAmount;
      // Without a director (music), a new style every SECTION metres, in a fixed shuffle.
      if (!this.directed) {
        const k = Math.floor(u.tunnelTravel.value / SECTION);
        if (k !== this.sectionK) {
          this.sectionK = k;
          this.setStyle(TUNNEL_STYLES[Math.floor(((((k * 0.618034 + 0.31) % 1) + 1) % 1) * TUNNEL_STYLES.length)]);
        }
      }
      // Once the gate is far behind, the new style is the whole tunnel.
      if (u.tunnelTravel.value > u.tunnelGate.value + BLEND + 60) u.tunnelFrom.value = u.tunnelTo.value;
      // The ambient light follows the style round the card.
      const here = u.tunnelTravel.value > u.tunnelGate.value + BLEND / 2 ? u.tunnelTo.value : u.tunnelFrom.value;
      if (here !== envStyle) env.bake((envStyle = here));
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
    // The style the tunnel is turning into (or is).
    get style() {
      return TUNNEL_STYLES[uniforms.tunnelTo.value];
    },
    // Still changing: the new style hasn't yet reached the card.
    get changing() {
      return uniforms.tunnelTravel.value < uniforms.tunnelGate.value + BLEND;
    },
    // Sends a style down the tunnel from ahead (now: switches at once).
    // centreIn: metres the card will travel before it is half way through the change (default: AHEAD + BLEND / 2).
    setStyle(name, now = false, centreIn = AHEAD + BLEND / 2) {
      const u = uniforms;
      const style = Math.max(0, TUNNEL_STYLES.indexOf(name));
      if (style === u.tunnelTo.value && !now) return;
      if (now) {
        u.tunnelFrom.value = u.tunnelTo.value = style;
        u.tunnelGate.value = -1e9;
        return;
      }
      // What the card is in becomes the old style; the new one comes from ahead.
      if (u.tunnelTravel.value >= u.tunnelGate.value + BLEND / 2) u.tunnelFrom.value = u.tunnelTo.value;
      u.tunnelTo.value = style;
      u.tunnelGate.value = u.tunnelTravel.value + Math.max(centreIn - BLEND / 2, 5);
    },
    // Who picks the styles: false, the travel (a new one every SECTION metres); true, the caller (setStyle).
    directed: false,
    sectionK: null,
    // The speed it last moved at (m/s).
    speed: 0,
    beatIndex: null,
  };
}

// The tunnel as the environment's ambient light: each style's, baked once, straight and still. (Reflections are traced:
// TUNNEL_TRACE_GLSL.)
function createEnvironmentBaker(renderer) {
  const scene = new Scene();
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    uniforms: { uStyle: { value: 0 }, tunnelTime: { value: 0 } },
    vertexShader: `uniform float uStyle; uniform float tunnelTime; out vec3 vP;\n${section}\nvoid main() { vP = position; vec3 p = position; p.xy *= tSection(uStyle, atan(p.y, p.x)); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uStyle; uniform float tunnelTime; in vec3 vP; out vec4 o;\n${wall}\nvoid main() { float a = atan(vP.y, vP.x); o = vec4(tunnelWall(uStyle, a, -vP.z, -vP.z, 0.08, tAngleWidth(a), fwidth(vP.z), 0.0), 1.0); }`,
  });
  scene.add(new Mesh(tube(96, 120), material));
  const pmrem = new PMREMGenerator(renderer);
  const baked = new Map();

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
    },
  };
}
