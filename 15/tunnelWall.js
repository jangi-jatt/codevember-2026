// The tunnel's wall in GLSL, on its own (no imports) so the explainer can draw it too: the styles, their blend from
// one into the next, the music's hits and the overlays. tunnel.js builds the tube and its materials round it.
export const RADIUS = 3.2;
export const BLEND = 60;
export const SECTION_GLSL = /* glsl */ `
// The styles: the one round the card, the one coming, and how far the new one has come in (0..1) at s. It comes in
// over BLEND metres past the gate, ahead of the card, and the gate then rushes past.
uniform float tunnelFrom;
uniform float tunnelTo;
uniform float tunnelGate;
vec3 tStyles(float s) {
  return vec3(tunnelFrom, tunnelTo, clamp((s - tunnelGate) / ${BLEND}.0, 0.0, 1.0));
}
// How far the tube has rolled at s.
float tRoll(float s) { return tunnelTime * 0.12 + s * 0.006; }
// The cross-section's radius at angle a, as a share of the tube's: round, a hexagon for the hex hall.
float tSection(float style, float a) {
  if (style != 2.0) return 1.0;
  float k = 6.2831853 / 6.0;
  return cos(k * 0.5) / cos(mod(a + k * 0.5, k) - k * 0.5);
}
`;

export const WALL_GLSL = /* glsl */ `
${SECTION_GLSL}
const float RADIUS_T = ${RADIUS.toFixed(1)};
// The lattice every style is drawn on, so their lines run on from one into the next: 24 lanes round the tube, and a
// unit along it as long as a lane is wide.
const float LANES = 24.0;
const float UNIT = 6.2831853 * RADIUS_T / LANES;
uniform float tunnelStreaks;
uniform float tunnelDots;
uniform float tunnelAutoPulse;
// Beats: with music the song's (bar * 4 + beat, so bars start on whole multiples of 4), else 130 BPM on the clock.
uniform float tunnelBeats;
uniform float tunnelHat;
// The tunnel's overall brightness (the song's intensity).
uniform float tunnelGain;
// How many kicks and hats so far (which cells answer each changes).
uniform float tunnelKickN;
uniform float tunnelHatN;
// How lit the tunnel is (0 dark, 1 full), for the intro.
uniform float tunnelLight;
uniform float tunnelKick;
uniform float tunnelWaveS;
uniform float tunnelWaveAmp;
// The ring at the card when the current beat began (its index along the tube).
uniform float tunnelCardRing;
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
// A line across the tube (r: distance to it along the tube, in the line's units) as it streams past for mv of travel:
// smeared into a band mv longer and dimmer, its light kept; 0..1. With mv 0 it is the still line's edge.
float tBand(float r, float width, float w, float mv) {
  float fade = min(2.0 * width + w, mv + w) / (mv + w);
  return fade * (1.0 - smoothstep(abs(width - 0.5 * mv), width + 0.5 * mv + w, r));
}

// The pattern styles (tiles, Memphis, suns) at one point: drawn as shapes, they are averaged over the streaming with
// taps, but only the pattern is (the rest of the wall is evaluated once).
vec3 tShape(float style, float a, float s, float blur, float da, float ds) {
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
    // The chase steps round a quarter turn on each beat.
    float stepB = floor(tunnelBeats) + smoothstep(0.0, 0.35, fract(tunnelBeats));
    float chase = 0.5 + 0.5 * sin(6.2831853 * (id.x / LANES + id.y / 24.0) - stepB * 1.5707963);
    lit *= 0.45 + 1.1 * chase * chase * chase;
    float glow = mix(tNeon(abs(box), 0.025, w), 0.3, smoothstep(0.15, 0.5, w));
    col = tPalette(floor(id.y / 9.0) + step(0.8, h)) * glow * lit;
    col += vec3(0.01, 0.002, 0.025);
  } else if (style == 5.0) {
    // Memphis: 80s shapes scattered one to each 3 x 3 block of cells over a faint grid: gradient discs, pink triangles,
    // yellow zigzags, outlined squares and hexagons, striped discs. Each turns a little on the beat.
    vec2 g = vec2(a / 6.2831853 * LANES, s / UNIT);
    vec2 gd = min(fract(g), 1.0 - fract(g));
    float w = max(da * RADIUS_T, ds) + blur;
    col = vec3(0.25, 0.1, 0.5) * (1.0 - smoothstep(0.0, 0.02 + w / UNIT, min(gd.x, gd.y))) * 0.25;
    vec2 uv = g / 3.0;
    vec2 id = vec2(mod(floor(uv.x), LANES / 3.0), floor(uv.y));
    vec2 h2 = vec2(tHash(id + 1.7), tHash(id + 8.3));
    float kind = floor(tHash(id + 5.1) * 6.0);
    float B = 3.0 * UNIT;
    vec2 p = (fract(uv) - 0.5 - (h2 - 0.5) * 0.12) * B;
    float ang = h2.x * 6.2831853 + (floor(tunnelBeats) + smoothstep(0.0, 0.3, fract(tunnelBeats))) * (h2.y - 0.5) * 0.6;
    p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
    float R = 0.32 * B;
    vec3 cyan = vec3(0.05, 0.85, 1.0), magenta = vec3(1.0, 0.1, 0.85), yellow = vec3(1.0, 0.9, 0.15), purple = vec3(0.45, 0.15, 1.0), orange = vec3(1.0, 0.55, 0.05);
    float fill = 0.0, line = 0.0;
    vec3 tint = cyan;
    if (kind < 1.0) {
      // A disc, cyan to purple.
      fill = 1.0 - smoothstep(-w, w, length(p) - R);
      tint = mix(purple, cyan, clamp(0.5 - p.y / R * 0.6, 0.0, 1.0));
    } else if (kind < 2.0) {
      // A triangle, pink.
      vec2 q = p / R;
      q.x = abs(q.x);
      float sd = max(q.x * 0.866 + q.y * 0.5, -q.y) - 0.5;
      fill = 1.0 - smoothstep(-w / R, w / R, sd);
      tint = mix(magenta, vec3(1.0, 0.5, 0.9), clamp(0.5 + p.y / R, 0.0, 1.0));
    } else if (kind < 3.0) {
      // A zigzag, yellow.
      float zig = (abs(fract(p.x / (0.28 * R) * 0.5) - 0.5) * 2.0 - 0.5) * 0.35 * R;
      line = (1.0 - smoothstep(0.035 * R, 0.035 * R + w, abs(p.y - zig))) * step(abs(p.x), 1.1 * R);
      tint = yellow;
    } else if (kind < 4.0) {
      // An outlined square, cyan.
      vec2 q = abs(p) - R * 0.85;
      line = 1.0 - smoothstep(0.02 * R, 0.02 * R + w, abs(max(q.x, q.y)));
      tint = cyan;
    } else if (kind < 5.0) {
      // A striped disc, pink or yellow.
      float inside = 1.0 - smoothstep(-w, w, length(p) - R * 0.9);
      float stripe = smoothstep(0.45, 0.55, abs(fract(p.y / (0.22 * R)) - 0.5) * 2.0);
      fill = inside * stripe;
      tint = h2.y < 0.5 ? magenta : yellow;
    } else {
      // An outlined hexagon, orange.
      vec2 q = abs(p);
      float hex = max(q.x * 0.866 + q.y * 0.5, q.y) - R;
      line = 1.0 - smoothstep(0.035 * R, 0.035 * R + w, abs(hex));
      tint = orange;
    }
    col += tint * (fill * 0.9 + line * 2.2);
    col += vec3(0.005, 0.002, 0.014);
  } else {
    // Retro suns: one to each 2 x 2 block, a sunset disc, a downward triangle or a square, in a two-colour gradient,
    // its lower half cut into stripes that widen toward the bottom; the stripes slide down on the beat.
    vec2 uv = vec2(a / 6.2831853 * LANES, s / UNIT) / 2.0;
    vec2 id = vec2(mod(floor(uv.x), LANES / 2.0), floor(uv.y));
    float B = 2.0 * UNIT;
    // Up is away from the card, down the tunnel.
    vec2 p = (fract(uv) - 0.5) * B;
    float h = tHash(id + 4.4), hk = tHash(id + 7.9), hc = tHash(id + 2.2);
    float w = max(da * RADIUS_T, ds) + blur;
    float R = 0.3 * B;
    float kind = floor(hk * 3.0);
    float sd;
    if (kind < 1.0) sd = length(p) - R;
    else if (kind < 2.0) {
      vec2 q = vec2(abs(p.x), p.y) / R;
      sd = max(q.x * 0.894 - q.y * 0.447 - 0.447, q.y - 0.8) * R;
    } else {
      vec2 q = abs(p) - R * 0.85;
      sd = max(q.x, q.y);
    }
    float fill = 1.0 - smoothstep(-w, w, sd);
    float v = clamp(0.5 - p.y / (2.0 * R), 0.0, 1.0);
    float slide = fract(tunnelBeats * 0.5) * 0.12;
    float cut = smoothstep(0.42, 1.0, v);
    float bands = fract((v + slide) / 0.12);
    // Stripes fade to their average where they'd be finer than a few pixels.
    float fine = smoothstep(0.2, 0.45, w / (2.0 * R * 0.12));
    fill *= mix(1.0 - step(bands, cut * 0.7) * step(0.42, v), 1.0 - cut * 0.5, fine);
    vec3 c0, c1;
    float pk = floor(hc * 6.0);
    if (pk < 1.0) { c0 = vec3(1.0, 0.55, 0.1); c1 = vec3(1.0, 0.1, 0.3); }
    else if (pk < 2.0) { c0 = vec3(1.0, 0.15, 0.4); c1 = vec3(0.35, 0.15, 0.7); }
    else if (pk < 3.0) { c0 = vec3(1.0, 0.8, 0.2); c1 = vec3(1.0, 0.2, 0.55); }
    else if (pk < 4.0) { c0 = vec3(0.45, 0.2, 0.75); c1 = vec3(0.1, 0.7, 1.0); }
    else if (pk < 5.0) { c0 = vec3(0.4, 0.75, 1.0); c1 = vec3(1.0, 0.3, 0.65); }
    else { c0 = vec3(0.1, 0.4, 1.0); c1 = vec3(1.0, 0.25, 0.4); }
    vec3 grad = mix(c0, c1, v);
    float lit = h > 0.12 ? 1.0 : 0.15;
    float breathe = 0.85 + 0.15 * sin((tunnelBeats + h * 4.0) * 1.5707963);
    col = grad * grad * fill * 0.6 * lit * breathe;
    // The sun's glow round it.
    if (kind < 1.0) col += mix(c0, c1, 0.5) * exp(-max(sd, 0.0) / (0.12 * B)) * 0.12 * lit * (1.0 - fill);
    col += vec3(0.006, 0.003, 0.016);
  }
  return col;
}

// Emission of the wall in one style at angle a, s metres down the tunnel, d ahead of the card; blur widens lines (for
// the environment's blurred bake); da, ds: screen widths of a radian and a metre.
// mv: how far the wall travels during the shutter (0: still), smearing the lines across the tube.
vec3 tunnelWall(float style, float a, float s, float d, float blur, float da, float ds, float mv) {
  vec3 col = vec3(0.0);
  if (style == 0.0 || style == 5.0 || style == 6.0) {
    // As many taps as the travel spans pixels (a third), up to 10.
    int n = int(clamp(ceil(mv / max(ds, 1e-5) / 3.0), 1.0, 10.0));
    for (int i = 0; i < 10; i++) {
      if (i >= n) break;
      col += tShape(style, a, s + (n == 1 ? 0.0 : mv * ((float(i) + 0.5) / float(n) - 0.5)), blur, da, ds);
    }
    col /= float(n);
  } else if (style == 1.0) {
    // Sparse rings, cyan and magenta, over a deep blue wall with a glossy purple floor.
    float v = s / (4.0 * UNIT);
    float k = floor(v + 0.5);
    float r = abs(fract(v + 0.5) - 0.5) * 4.0 * UNIT;
    float w = ds + blur;
    vec3 ring = mod(k, 2.0) < 1.0 ? vec3(0.12, 0.55, 1.0) : vec3(0.85, 0.15, 1.0);
    // Every fourth ring flashes on each beat, counted from the one passing the card then (locked to the music, it is
    // there on the beat).
    float hit = mod(k - tunnelCardRing, 4.0) < 0.5 ? smoothstep(0.0, 0.08, fract(tunnelBeats)) * exp(-fract(tunnelBeats) * 3.0) : 0.0;
    float beat = 0.45 + 0.9 * hit;
    col = ring * mix(4.0 * tBand(r, 0.035, w, mv), 0.5, smoothstep(0.6, 2.0, w)) * beat;
    // Fine rings between, and four light strips along the tube.
    float rFine = abs(fract(s / UNIT + 0.5) - 0.5) * UNIT;
    col += ring.bgr * mix(4.0 * tBand(rFine, 0.008, w, mv), 0.15, smoothstep(0.2, 0.6, w)) * 0.12;
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
    // The frames: lines along the tube, and across it (smeared as it streams).
    float frame = max(1.0 - smoothstep(0.012, 0.012 + w, (0.5 - abs(f.x)) * 1.1), tBand((0.5 - abs(f.y)) * 1.1, 0.012, w, mv / UNIT * 1.1));
    col = vec3(0.45, 0.2, 1.0) * mix(4.0 * frame, 0.15, smoothstep(0.2, 0.6, w)) * 0.35;
    float g = s / (12.0 * UNIT);
    float gate = floor(g + 0.5);
    float rGate = abs(fract(g + 0.5) - 0.5) * 12.0 * UNIT;
    col += (mod(gate, 2.0) < 1.0 ? vec3(0.9, 0.25, 1.0) : vec3(0.3, 0.45, 1.0)) * mix(4.0 * tBand(rGate, 0.07, w, mv), 0.6, smoothstep(0.6, 2.0, w));
    col += vec3(0.006, 0.003, 0.018);
    float h = tHash(id + 3.1);
    // A few panels glow from behind, fading in and out.
    float panel = smoothstep(0.75, 1.0, tHash(id + 5.7)) * (0.5 + 0.5 * sin(tunnelBeats * 1.5707963 + h * 40.0));
    col += mix(vec3(0.25, 0.1, 0.8), vec3(0.8, 0.2, 0.9), tHash(id + 1.9)) * panel * 0.12 * smoothstep(0.5, 0.3, max(abs(f.x), abs(f.y)));
    if (h < 0.06 && blur < 0.05) {
      vec2 o = (vec2(tHash(id + 7.3), tHash(id + 9.1)) - 0.5) * 0.6;
      float flicker = 0.6 + 0.4 * sin(tunnelTime * 9.0 + h * 600.0) + 1.2 * tunnelHat;
      // A soft spot, stretched along the tube as it streams (a box over mv widens its variance by mv^2 / 12).
      float vy = 0.002 + (mv / UNIT) * (mv / UNIT) / 12.0;
      vec2 e = f - o;
      col += vec3(1.0, 0.45, 0.1) * exp(-e.x * e.x / 0.004 - e.y * e.y / (2.0 * vy)) * sqrt(0.002 / vy) * 6.0 * flicker;
    }
  } else if (style == 4.0) {
    // Laser lanes: a thin line down every other lane over a near-black wall, beams of light racing along them on the
    // beat, and a faint ring every 8 units.
    float u = a / 6.2831853 * LANES;
    float lane = mod(floor(u + 0.5), LANES);
    float rl = abs(fract(u + 0.5) - 0.5) * UNIT;
    float w = da * RADIUS_T + blur;
    float on = mod(lane, 2.0);
    float h = tHash(vec2(lane, 5.0));
    vec3 tint = h < 0.5 ? vec3(1.0, 0.12, 0.25) : vec3(0.15, 0.9, 1.0);
    // Beams: one per lane every 8 units, moving a unit a beat toward the card, staggered by lane.
    float b = fract((s + tunnelBeats * UNIT * 2.0) / (8.0 * UNIT) + h);
    float beam = smoothstep(0.0, 0.02, b) * pow(1.0 - b, 6.0);
    // Streaming, averaged over the shutter's travel (the tail's integral; the head's short rise left out).
    float db = 0.5 * mv / (8.0 * UNIT);
    if (db > 1e-4) beam = (pow(1.0 - max(b - db, 0.0), 7.0) - pow(1.0 - min(b + db, 1.0), 7.0)) / (14.0 * db);
    col = tint * mix(tNeon(rl, 0.004, w), 0.05, smoothstep(0.05, 0.2, w)) * on * (0.25 + 2.5 * beam);
    float rr = abs(fract(s / (8.0 * UNIT) + 0.5) - 0.5) * 8.0 * UNIT;
    col += vec3(0.5, 0.2, 1.0) * mix(4.0 * tBand(rr, 0.006, ds + blur, mv), 0.03, smoothstep(0.1, 0.4, ds + blur)) * 0.25;
    col += vec3(0.004, 0.002, 0.012);
  } else {
    // The synthwave grid: lines along and round the tube, magenta to cyan round it.
    vec2 uv = vec2(a / 6.2831853 * LANES, s / UNIT);
    vec2 dd = min(fract(uv), 1.0 - fract(uv));
    float w = max(da / 6.2831853 * LANES, ds / UNIT) + blur * 0.3;
    float across = tBand(dd.y, 0.02, 1.5 * w, mv / UNIT);
    float lines = max(1.0 - smoothstep(0.012, 0.012 + 1.5 * w, dd.x), across);
    lines = mix(lines, 0.06, smoothstep(0.25, 0.7, w));
    vec3 tint = mix(vec3(1.0, 0.1, 0.65), vec3(0.1, 0.85, 1.0), 0.5 + 0.5 * sin(a * 2.0 + s * 0.03));
    // Every fourth ring a bright one, and a scan of light sweeping round the tube.
    float major = 1.0 + 1.5 * step(mod(floor(uv.y + 0.5), 4.0), 0.5) * across;
    // The scan goes round once a bar.
    float sweep = pow(0.5 + 0.5 * cos(a - tunnelBeats * 1.5707963 + s * 0.05), 12.0);
    col = tint * lines * (1.6 + 2.4 * sweep) * major + vec3(0.012, 0.0, 0.025) + tint * sweep * 0.05;
  }
  // Pulses of light racing toward the card, faster than the wall (on their own beat, without music).
  float wave = fract(s / 60.0 + tunnelTime * 0.45);
  float pulse = exp(-pow((wave - 0.5) * 20.0, 2.0)) * tunnelAutoPulse;
  // With music: each kick flashes the walls and sends a ring of light away down the tunnel.
  float ring = exp(-pow((s - tunnelWaveS) / 2.5, 2.0)) * tunnelWaveAmp;
  col *= (1.0 + 1.6 * pulse + 2.2 * ring + 0.7 * tunnelKick) * tunnelGain;
  // Down the tunnel (and back up it, behind the card) it fades into a coloured haze.
  vec3 haze = style == 0.0 ? vec3(0.5, 0.08, 0.2) : style == 1.0 ? vec3(0.15, 0.08, 0.5) : style == 2.0 ? vec3(0.25, 0.08, 0.45) : style == 4.0 ? vec3(0.4, 0.05, 0.15) : style == 5.0 ? vec3(0.4, 0.15, 0.35) : style == 6.0 ? vec3(0.1, 0.15, 0.5) : vec3(0.45, 0.06, 0.35);
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
vec3 tDots(float a, float s, float da, float ds, float blur, float mv) {
  float spacing = 1.1;
  float v = s / spacing;
  float k = floor(v + 0.5);
  float dv = (fract(v + 0.5) - 0.5) * spacing;
  float u = (a + k * 0.21 + tunnelTime * 0.5) / 6.2831853 * LANES;
  float du = (fract(u) - 0.5) * UNIT;
  // Streaming, each dot smears into a dash mv long, its light kept.
  float r = length(vec2(du, max(abs(dv) - 0.5 * mv, 0.0)));
  float w = max(ds, da * RADIUS_T) + blur;
  vec3 tint = 0.5 + 0.5 * cos(6.2831853 * (k * 0.045 + vec3(0.0, 0.33, 0.67)));
  tint = mix(tint, vec3(1.0, 0.15, 0.7), 0.35);
  float twinkle = 0.6 + 0.4 * sin(tunnelBeats * 3.1415927 + k * 0.9 + floor(u) * 2.4) + tunnelHat;
  float fade = (0.08 + w) / (mv + 0.08 + w);
  return tint * mix(tNeon(r, 0.04, w) * fade, 0.15, smoothstep(0.15, 0.45, w)) * twinkle;
}

// The wall at raw angle a (atan's): the section's style, rolled, with the next one coming in over it block by block.
vec3 tunnelBlendAt(float a, float s, float d, float blur, float da, float ds, float mv) {
  vec3 st = tStyles(s);
  float ar = a + tRoll(s);
  vec3 col = tunnelWall(st.x, ar, s, d, blur, da, ds, mv);
  if (st.z > 0.0) {
    vec3 next = tunnelWall(st.y, ar, s, d, blur, da, ds, mv);
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
  // The cells answer the music: a scatter of them flashes on each kick, fewer sparkle on the hats.
  vec2 cell = vec2(mod(floor(ar / 6.2831853 * LANES), LANES), floor(s / UNIT));
  // Streaming, a cell's flash spills into its neighbours along the tube by how much of the travel crosses into them.
  float hw = 0.5 * mv / UNIT, fy = fract(s / UNIT);
  float wPrev = hw > 0.0 ? clamp((hw - fy) / (2.0 * hw), 0.0, 1.0) : 0.0;
  float wNext = hw > 0.0 ? clamp((hw - 1.0 + fy) / (2.0 * hw), 0.0, 1.0) : 0.0;
  float hits = 0.0;
  for (int j = -1; j <= 1; j++) {
    float wj = j == 0 ? 1.0 - wPrev - wNext : j < 0 ? wPrev : wNext;
    if (wj <= 0.0) continue;
    vec2 c = cell + vec2(0.0, float(j));
    hits += wj * (3.0 * step(tHash(c + tunnelKickN * 1.371), 0.16) * tunnelKick + 2.0 * step(tHash(c * 1.31 + tunnelHatN * 2.113), 0.05) * tunnelHat);
  }
  col *= 1.0 + hits;
  float far = exp(-abs(d) / 45.0);
  if (tunnelStreaks > 0.001) col += tStreaks(ar, s, da, blur) * tunnelStreaks * far;
  if (tunnelDots > 0.001) col += tDots(ar, s, da, ds, blur, mv) * tunnelDots * far;
  return col;
}

vec3 tunnelBlend(float a, float s, float d, float blur) {
  // Derivatives before any branch, and from the raw angle so its wrap is handled once.
  return tunnelBlendAt(a, s, d, blur, tAngleWidth(a), fwidth(s), 0.0);
}

// The wall as a camera sees it while it streams past for a shutter, over the len metres it travels then.
vec3 tunnelBlendMoving(float a, float s, float d, float len) {
  return tunnelBlendAt(a, s, d, 0.0, tAngleWidth(a), fwidth(s), len);
}
`;
