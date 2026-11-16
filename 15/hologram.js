// The hologram: dark smoked glass with a diffraction-grating hologram seen through it by refraction, as a
// PipelineMaterial. The glass is the PBR surface; the hologram is its emission, in one of three modes:
// a camera-facing stage inside the volume, a deep chamber behind every face, or a 3D clockwork raymarched inside.
// Each chamber holds a 3D scene (diorama.js: clockwork or a burst) in a bowl of rings.
import { Color, Matrix3, Vector2, Vector3 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { TUNNEL_TRACE_GLSL } from "./tunnel.js";

export const LOOK_PRESETS = {
  spectrum: {
    label: 'Spectrum',
    spacing: 1100,
    order2: 0.30,
    order3: 0.10,
    hueShift: 0.0,
    holoBrightness: 1.05,
    holoSaturation: 1.20,
    purity: 0.80,
    softClip: 0.60,
    glassIor: 1.54,
    plateReflection: 0.30,
    wear: 0.85,
    tintMix: 0.0,
    tintColor: '#59e0ff',
    rampMix: 0.0,
    rampCycles: 1.0,
    stops: ['#3b28ff', '#ff2bd0', '#ffb300', '#00d6b4', '#7c2bff'],
  },
  oil: {
    label: 'Oil Slick',
    spacing: 1100,
    order2: 0.30,
    order3: 0.10,
    hueShift: 0.0,
    holoBrightness: 1.06,
    holoSaturation: 1.22,
    purity: 0.82,
    softClip: 0.60,
    glassIor: 1.58,
    plateReflection: 0.32,
    wear: 0.80,
    tintMix: 0.0,
    tintColor: '#c4128f',
    rampMix: 1.0,
    rampCycles: 2.0,
    stops: ['#1b2bd6', '#c4128f', '#ffb000', '#00c9a7', '#5a1fd1'],
  },
  infrared: {
    label: 'Infrared',
    spacing: 1120,
    order2: 0.28,
    order3: 0.09,
    hueShift: 0.0,
    holoBrightness: 1.08,
    holoSaturation: 1.22,
    purity: 0.82,
    softClip: 0.58,
    glassIor: 1.56,
    plateReflection: 0.30,
    wear: 0.78,
    tintMix: 0.0,
    tintColor: '#ff3b1f',
    rampMix: 1.0,
    rampCycles: 1.0,
    stops: ['#2b0a7a', '#c2188f', '#ff3b1f', '#ff9d0a', '#ffe98a'],
  },
};

const vertexPars = /* glsl */ `
in vec4 faceT;
in vec3 faceB;
in vec4 faceP;
`;

const vertexMain = /* glsl */ `
  mat3 holoRot = mat3(modelMatrix);
  vWorldFaceT = normalize(holoRot * faceT.xyz);
  vWorldFaceB = normalize(holoRot * faceB);
  vObjViewVec = (cameraPosition - world.xyz) * holoRot;
  vObjFaceT = faceT;
  vObjFaceB = faceB;
  vFaceP = faceP;
`;

const varyings = {
  vWorldFaceT: "vec3",
  vWorldFaceB: "vec3",
  vObjViewVec: "vec3",
  vObjFaceT: "vec4",
  vObjFaceB: "vec3",
  vFaceP: "vec4",
};

const fragmentPars = /* glsl */ `

#define vWorldPos vWorldPosition
#define vObjPos vObjectPosition
#define vObjNormal vObjectNormal
// One program per mode: the other branches fold away at compile time.
#define uSolidMode float(HOLO_MODE)

  uniform sampler2D uPortal;
  uniform sampler2D uReplay0;
  uniform sampler2D uReplay1;
  uniform sampler2D uReplay2;
  uniform float uBandT[12];
  uniform int uBandCount;
  uniform float uLambda0;
  uniform float uBandwidth;
  uniform float uSwelling;
  uniform vec3 uSwellSeed;
  uniform float uDisperse;
  uniform vec3 uBandStep;
  uniform float uPortalNear;
  uniform float uPortalSpan;
  uniform vec2 uProj;
  uniform vec2 uScreen;
  uniform float uRefractShift;

  uniform mat3 uModelRot;
  uniform vec3 uHeroCenter;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform vec3 uCamFwd;
  uniform vec2 uCoreTilt;
  uniform float uCoreSubject;

  uniform float uTime;
  uniform int uMarchSteps;
  uniform int uRaySteps;
  // Loop bounds as uniforms, so D3D's compiler can't unroll the loops into every inlined call.
  uniform int uOne;
  uniform int uThree;
  uniform int uFour;

  uniform vec3 uLights[4];
  uniform float uLightPower[4];

  uniform vec3 uSubstrateColor;
  uniform vec3 uEdgeColor;
  uniform vec3 uTintColor;

  uniform float uRampMix;
  uniform float uRampCycles;
  uniform vec3 uRamp1;
  uniform vec3 uRamp2;
  uniform vec3 uRamp3;
  uniform vec3 uRamp4;
  uniform vec3 uRamp5;

  uniform float uSpacing;
  uniform float uOrder2;
  uniform float uOrder3;
  uniform float uHueShift;
  uniform float uHoloBrightness;
  uniform float uHoloSaturation;
  uniform float uPurity;
  uniform float uSoftClip;
  uniform float uTintMix;

  uniform float uGlassIor;
  uniform float uDepthScale;
  uniform float uRingAmount;
  uniform float uBowlDepth;
  uniform float uRingCount;
  uniform float uRingDash;
  // A faint solid track under each ring's dashes (0: none).
  uniform float uRingTrack;
  uniform float uBraggWidth;
  uniform float uFrameBand;
  uniform float uPlateReflection;
  uniform float uWear;
  uniform float uGlassRoughness;
  uniform float uHoloGain;
  uniform float uHaze;
  uniform float uGhost;
  uniform float uZone;
  uniform float uGraze;
  uniform float uCardAspect;
  uniform float uCardBorder;
  uniform float uCardCorner;
  uniform float uFoil;
  uniform sampler2D uSmudge;
  uniform float uSmudgeAmount;
  // The lamp above the camera (uLights[3]) reflected in the card: a hotspot where it mirrors toward the eye.
  uniform float uTorchGain;

  // How grazing the glass is seen here (set per pixel in surface()), and the hue slide it causes.
  float holoGraze = 0.0;
  float holoHueShift = 0.0;
  // The view at this pixel, and where the glass bends it on the screen (set in surface()).
  vec3 holoWorldV = vec3(0.0, 0.0, 1.0);
  vec2 holoScreenShift = vec2(0.0);
  vec3 holoNormal = vec3(0.0, 0.0, 1.0);
  float holoGrazeNow = 0.0;
  // Metal reflects in full and needs no lift (set in surface()).
  float holoMetal = 0.0;

  // The scene's buffer at uv; in Faces mode only this face's own copy (its window id, read unfiltered).
  vec4 samplePortal(vec2 uv) {
    vec4 gb = textureLod(uPortal, uv, 0.0);
#if HOLO_MODE == 1 && HOLO_CARD == 0
    float windowId = texelFetch(uPortal, ivec2(clamp(uv, 0.0, 1.0) * vec2(textureSize(uPortal, 0) - 1)), 0).b;
    if (abs(windowId - (vObjFaceT.w + 1.0)) > 0.5) gb = vec4(0.0);
#endif
    return gb;
  }

  const float PI = 3.141592653589793;
  const float TAU = 6.283185307179586;

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  vec4 hash42(vec2 p) {
    vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
    p4 += dot(p4, p4.wzxy + 33.33);
    return fract((p4.xxyz + p4.yzzw) * p4.zywx);
  }

  float valueNoise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // ---- Alan Zucconi Visible Spectrum + Optional 5-Stop Look Ramp (matching solid.ts) ----
  vec3 bump3(vec3 x, vec3 y) {
    return clamp(vec3(1.0) - x * x - y, 0.0, 1.0);
  }

  vec3 evalRamp5(float t) {
    float s = clamp(t, 0.0, 1.0) * 4.0;
    vec3 c = mix(uRamp1, uRamp2, clamp(s, 0.0, 1.0));
    c = mix(c, uRamp3, clamp(s - 1.0, 0.0, 1.0));
    c = mix(c, uRamp4, clamp(s - 2.0, 0.0, 1.0));
    c = mix(c, uRamp5, clamp(s - 3.0, 0.0, 1.0));
    return c * 1.25;
  }

  vec3 spectral(float w) {
    float x = clamp((w - 400.0) / 300.0, 0.0, 1.0);
    vec3 a = bump3(
      vec3(3.54585104, 2.93225262, 2.41593945) * (vec3(x) - vec3(0.69549072, 0.49228336, 0.27699880)),
      vec3(0.02312639, 0.15225084, 0.52607955)
    );
    vec3 b = bump3(
      vec3(3.90307140, 3.21182957, 3.96587128) * (vec3(x) - vec3(0.11748627, 0.86755042, 0.66077860)),
      vec3(0.84897130, 0.88445281, 0.73949448)
    );
    vec3 rainbow = a + b;
    if (uRampMix > 0.001) {
      float cyc = fract(x * uRampCycles * 0.5);
      float tri = 1.0 - abs(cyc * 2.0 - 1.0);
      rainbow = mix(rainbow, evalRamp5(tri), uRampMix);
    }
    float win = smoothstep(385.0, 435.0, w) * (1.0 - smoothstep(660.0, 725.0, w));
    return rainbow * win;
  }

  vec3 diffract(float u) {
    float a = abs(u + uHueShift) * uSpacing;
    return spectral(a) + spectral(a * 0.5) * uOrder2 + spectral(a / 3.0) * uOrder3;
  }

  // The replay's bands at uv (each band's brightness in a channel, four to a buffer), each coloured by its wavelength
  // round this pixel's centre and Gaussian weighted; normalized so an even area keeps its brightness.
  // du: one band's spacing on screen here; each buffer is averaged across it, so the bands' copies join into a smear.
  vec3 bandColour(vec2 uv, float centre, vec2 du) {
    vec4 b0 = vec4(0.0), b1 = vec4(0.0), b2 = vec4(0.0);
    // A tent two spacings wide, so neighbouring copies overlap into one smear.
    float wsum = 0.0;
    for (int j = 0; j < 8 * uOne; j++) {
      float x = (float(j) + 0.5) / 8.0 * 2.0 - 1.0;
      float w = 1.0 - abs(x);
      vec2 at = uv + du * x;
      b0 += textureLod(uReplay0, at, 0.0) * w;
      // Only the buffers holding bands (four to each).
      if (uBandCount > 4) b1 += textureLod(uReplay1, at, 0.0) * w;
      if (uBandCount > 8) b2 += textureLod(uReplay2, at, 0.0) * w;
      wsum += w;
    }
    b0 /= wsum;
    b1 /= wsum;
    b2 /= wsum;
    vec3 col = vec3(0.0);
    float norm = 0.0;
    for (int k = 0; k < uBandCount; k++) {
      float lum = k < 4 ? b0[k] : k < 8 ? b1[k - 4] : b2[k - 8];
      float t = uBandT[k];
      vec3 c = spectral(clamp(centre + t * 2.0 * uBandwidth, 380.0, 760.0));
      // Falls to almost nothing by the outermost bands, so the smear has no hard outer edge (their copies' outlines).
      float g = exp(-4.0 * t * t);
      col += c * (g * lum);
      norm += g * dot(c, vec3(0.2126, 0.7152, 0.0722));
    }
    return col / max(norm, 1e-3);
  }

  // ---- Exact holo.ts / solid.ts 4-Light Tangent-Frame Grating Evaluator ----
  struct ChamberLights {
    vec3 T;
    vec3 B;
    vec3 N;
    vec3 Vt;
  };

  ChamberLights buildChamberLights(vec3 Tw, vec3 Bw, vec3 Nw, vec3 Vt) {
    return ChamberLights(Tw, Bw, Nw, Vt);
  }

  // Light i in the chamber's frame, its half vector, and its power (faded below the plate).
  vec3 clLt(ChamberLights cl, int i) {
    vec3 L = uLights[i];
    return vec3(dot(L, cl.T), dot(L, cl.B), dot(L, cl.N));
  }
  vec3 clHt(ChamberLights cl, int i) {
    return normalize(clLt(cl, i) + cl.Vt);
  }
  float clPower(ChamberLights cl, int i) {
    return uLightPower[i] * smoothstep(-0.30, 0.25, clLt(cl, i).z);
  }

  // Flat grating layer (rings, micro-facets, PCB overlay, hairline): shade = 1.0
  vec3 litFlatGrating(ChamberLights cl, vec3 Vt, vec2 g, float extra) {
    vec3 sumCol = vec3(0.0);
    vec3 topCol = vec3(0.0);
    for (int i = 0; i < uFour; i++) {
      if (clPower(cl, i) > 0.0005) {
        vec3 c = diffract(dot(clLt(cl, i).xy + Vt.xy, g) + extra) * clPower(cl, i);
        sumCol += c;
        topCol = max(topCol, c);
      }
    }
    return mix(sumCol, topCol, uPurity);
  }

  // 3D bas-relief grating layer: single constant grating gA + Lambert/Blinn relief shading
  vec3 litReliefGrating(ChamberLights cl, vec3 Vt, vec2 g, float extra, vec3 nA) {
    vec3 sumCol = vec3(0.0);
    vec3 topCol = vec3(0.0);
    for (int i = 0; i < uFour; i++) {
      if (clPower(cl, i) > 0.0005) {
        float diff = max(dot(nA, normalize(clLt(cl, i))), 0.0) * 1.20;
        float spec = pow(max(dot(nA, clHt(cl, i)), 0.0), 26.0) * 1.40;
        float shade = 0.14 + diff + spec;
        vec3 c = diffract(dot(clLt(cl, i).xy + Vt.xy, g) + extra) * (shade * clPower(cl, i));
        sumCol += c;
        topCol = max(topCol, c);
      }
    }
    return mix(sumCol, topCol, uPurity);
  }

  // The original's gauge-block rings, laid on a paraboloid bowl round the scene: deepest at the centre, rising toward
  // the glass at the rim. The view ray (sliding by -off per unit depth) meets it where d = D - a r^2, a quadratic in d.
  vec3 ringBowl(ChamberLights cl, vec3 Vt, vec2 st, vec2 off) {
    float D = 0.36 * uDepthScale * uBowlDepth;
    float a = (D - 0.015) / 0.56;
    // Deeper points slide against the view, as the rest of the chamber's layers do (st - off * d).
    off = -off;
    vec2 c = st - 0.5;
    float A = a * dot(off, off);
    float B = 1.0 + 2.0 * a * dot(c, off);
    float C = a * dot(c, c) - D;
    float disc = B * B - 4.0 * A * C;
    if (disc < 0.0) return vec3(0.0);
    float d = A > 1e-5 ? (-B + sqrt(disc)) / (2.0 * A) : -C / B;
    d = max(d, 0.0);
    vec2 p = c + off * d;
    vec2 pr = p * 2.0;
    float rr = length(pr);

    float ringCoord = rr * uRingCount;
    float px = max(fwidth(ringCoord), 1e-4) + 0.3 * holoGrazeNow;
    float ringI = floor(ringCoord);
    float ringF = fract(ringCoord);
    float odd = mod(ringI, 2.0);
    float ang = atan(pr.y, pr.x);
    float th = ang + uTime * 0.05 * (odd * 2.0 - 1.0) + ringI * 0.37;
    float dashes = floor((ringI + 1.0) * 11.0);
    float dashF = fract(th / TAU * dashes);
    float dpx = max(fwidth(th / TAU * dashes), 1e-4) + 0.3 * holoGrazeNow;
    float band = 1.0 - smoothstep(0.45 * 0.5 - px, 0.45 * 0.5 + px, abs(ringF - 0.5));
    float dash = 1.0 - smoothstep(uRingDash * 0.5 - dpx, uRingDash * 0.5 + dpx, abs(dashF - 0.5));
    // Each ring's track its own strength (from its index and the card's seed): none, faint or strong, for contrast.
    float th2 = hash21(vec2(ringI * 1.37 + 3.1, uSwellSeed.x));
    float track = uRingTrack * (th2 < 0.35 ? 0.0 : th2 < 0.75 ? 0.6 : 2.0);
    // Rings finer than a pixel fade to their average.
    float on = mix(band * mix(track, 1.0, dash), 0.45 * mix(track, 1.0, uRingDash), smoothstep(0.25, 0.6, px)) * smoothstep(0.12, 0.3, rr);
    if (on < 0.002) return vec3(0.0);

    // Shaded by the bowl's slope: its walls face in toward the scene.
    vec3 nB = normalize(vec3(-2.0 * a * p * 2.0, 1.0));
    float ga = ang + odd * (PI * 0.5);
    return litReliefGrating(cl, Vt, vec2(cos(ga), sin(ga)), ringI * 0.03 + holoHueShift, nB) * (on * 0.6);
  }

  // ============================================================================
  // The chamber: the 3D scene in a bowl of rings.
  // ============================================================================
  vec3 evalHoloChamber(
    vec2 st,
    vec2 off,
    float aaPlate,
    vec3 Tw,
    vec3 Bw,
    vec3 Nw,
    vec3 Vw,
    float subjectId,
    float overlayId,
    float ringOuterMax,
    float edgeFadeMask
  ) {
    vec3 Vt = vec3(dot(Vw, Tw), dot(Vw, Bw), max(dot(Vw, Nw), 0.18));
    ChamberLights cl = buildChamberLights(Tw, Bw, Nw, Vt);

    // How grazing the view is: the hologram's colour slides along the spectrum, its layers spread in depth, its rings
    // soften, and the scene spreads into rainbow bands (below).
    float graze = uGraze * max(holoGraze, 1.0 - smoothstep(0.3, 0.95, Vt.z));
    holoGrazeNow = graze;
    holoHueShift = 0.3 * graze;
    // Depth grows with the angle: the layers behind the plate slide further apart.
    off *= 1.0 + 1.5 * graze * graze;

    // 1. The 3D scene inside (diorama.js), rendered through the glass: its normal and depth where the glass bends the
    // view here, lit through the grating in the camera's frame.
    vec2 suv = gl_FragCoord.xy / uScreen + holoScreenShift;
    vec4 gb = samplePortal(suv);
    float presence = smoothstep(0.02, 0.12, gb.g);

    vec3 art = vec3(0.0);
    vec3 plain = vec3(0.0);
    {
      // The replay (diorama.js): the scene rebuilt in bands of wavelength, each sheared about the plate, coloured here
      // per pixel. The plate's fringes (half way between its normal and a reference beam from the front and above)
      // mirror each light toward the eye, brightest near the mirror direction, in a band centred on lambda0 cos(theta)
      // (inside the gelatin). The lights are lamps a few units off, so their angle, and with it the colour, sweeps
      // across the plate.
      vec3 Np = holoNormal;
      vec3 Bp = normalize(vec3(0.0, 1.0, 0.0) - Np * Np.y + vec3(0.0, 0.0, 1e-4));
      vec3 Rp = normalize(Np + Bp);
      vec3 nf = normalize(Np + Rp);
      float n2 = 1.52 * 1.52;
      float cRec = dot(Rp, nf);
      float cosRec = sqrt(1.0 - (1.0 - cRec * cRec) / n2);
      float lobeSum = 0.0;
      float lambdaB = 0.0;
      for (int i = 0; i < uFour; i++) {
        vec3 L = normalize(uHeroCenter + uLights[i] * 4.0 - vWorldPos);
        float lobe = uLightPower[i] * (0.15 + 0.85 * exp((dot(normalize(L + holoWorldV), nf) - 1.0) / uBraggWidth)) * step(0.0, dot(L, Np));
        float c = clamp(dot(L, nf), 0.0, 1.0);
        lambdaB += uLambda0 * sqrt(1.0 - (1.0 - c * c) / n2) / cosRec * lobe;
        lobeSum += lobe;
      }
      lambdaB = lobeSum > 1e-4 ? lambdaB / lobeSum : uLambda0;
      // The gelatin swelled unevenly in development: toward gold and red in broad patches, and more toward the edges.
      vec3 sp = vObjPos * 1.4 + uSwellSeed;
      float swell = valueNoise2D(sp.xy + sp.z * 0.71) * 0.65 + valueNoise2D(sp.yz * 2.1 + 7.3) * 0.35;
      float rim = smoothstep(0.35, 1.15, length(vObjPos));
      lambdaB *= 1.0 + uSwelling * (0.03 + 0.12 * swell + 0.1 * rim);
      // Eased toward deep red, never past it: bands beyond the visible end have nothing to show, and their colour (scaled
      // back up to the replay's brightness) broke up into hard edges along the swelling.
      float knee = 600.0, top = 690.0 - 1.2 * uBandwidth;
      if (lambdaB > knee) lambdaB = knee + (max(top, knee + 10.0) - knee) * tanh((lambdaB - knee) / max(top - knee, 10.0));
      // Where the bands' copies of this point fall on screen (as diorama.js shears them): along the lights' direction
      // across the plate, a band apart per (2 / bands) of the spread, by the point's depth from the plate.
      // The copies are smoothed together over one band spacing of the deepest parts, the same everywhere: smoothing by each
      // pixel's own depth jumps at a part's outline, and the blur then ends there in a hard line.
      float zPlate = dot(cameraPosition - vWorldPos, uCamFwd);
      vec3 stepW = uBandStep * 0.6;
      vec2 du = vec2(dot(stepW, uCamRight), dot(stepW, uCamUp)) * uProj / max(zPlate, 0.1);
      vec3 replay = bandColour(suv, lambdaB, du);
#if HOLO_MODE == 1 && HOLO_CARD == 0
      // Never a neighbour window's light.
      float otherId = texelFetch(uPortal, ivec2(clamp(suv, 0.0, 1.0) * vec2(textureSize(uPortal, 0) - 1)), 0).b;
      if (otherId > 0.5 && abs(otherId - (vObjFaceT.w + 1.0)) > 0.5) replay = vec3(0.0);
#endif
      // Ghostly, as a plate of light: a halo of light scattered in the emulsion and glass round the bright parts (in
      // their colour), the shadows lifted a little, and a fine speckle.
      if (uGhost > 0.001) {
        vec2 px = 1.0 / uScreen;
        float halo = 0.0;
        // A ring of taps round the pixel, from a coarse mip of the bands (each tap already an average over ~16 pixels, so the
        // halo carries no copies of the image's edges).
        for (int k = 0; k < 8 * uOne; k++) {
          float a = float(k) * 0.785398;
          vec2 at = suv + vec2(cos(a), sin(a)) * px * 22.0;
          float b = dot(textureLod(uReplay0, at, 3.0), vec4(1.0));
          if (uBandCount > 4) b += dot(textureLod(uReplay1, at, 3.0), vec4(1.0));
          halo += b / max(float(uBandCount), 1.0) * 1.65;
        }
        vec3 hue = spectral(lambdaB) / max(dot(spectral(lambdaB), vec3(0.2126, 0.7152, 0.0722)), 1e-3);
        replay += hue * halo * (0.045 * uGhost);
        replay = mix(replay, sqrt(replay * max(dot(replay, vec3(0.333)), 0.0)), 0.25 * uGhost);
        float speckle = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        replay *= 1.0 + (speckle - 0.5) * 0.08 * uGhost;
      }
      art = replay * (lobeSum * 0.5 * uHoloSaturation);
    }

    vec3 bg = vec3(0.0);
    // The rings are part of the same recording: anything in the scene, lit or dark, hides what's behind it. (Where the
    // image is dark the plate gives no light, so it looks clear through to whatever is behind the glass.)
    // Ghostly: dim parts of the scene let the rings show through faintly; bright ones hide them.
    float glow = smoothstep(0.03, 0.5, dot(art, vec3(0.2126, 0.7152, 0.0722)));
    float behind = 1.0 - presence * mix(1.0, mix(0.45, 1.0, glow), uGhost);
    if (uRingAmount > 0.001 && behind > 0.002) bg = ringBowl(cl, Vt, st, off) * (uRingAmount * behind);

    // The emulsion's own glow: a faint violet-blue haze where nothing is drawn, deeper toward the edges.
    float hz = behind * uHaze * (0.5 + length(st - 0.5));
    vec3 haze = mix(vec3(0.12, 0.06, 0.5), vec3(0.04, 0.22, 0.42), clamp(Vt.y * 2.0 + 0.5, 0.0, 1.0)) * hz;

    float vig = 1.0 - 0.28 * smoothstep(0.28, 0.85, length(st - 0.5) * 1.42);
    // Past its viewing zone the image fades.
    // Past its viewing zone the plate has nothing more to show: the hologram fades out toward the zone's edge.
    float viewAngle = acos(clamp(dot(holoWorldV, holoNormal), 0.0, 1.0));
    float inZone = 1.0 - smoothstep(uZone * 0.75, uZone, viewAngle);
    vec3 colour = (art + plain + bg + haze) * inZone;
    float peak = max(max(colour.r, colour.g), colour.b);
    vec3 kept = colour * ((1.0 + 0.5 * uSoftClip) / (1.0 + peak * uSoftClip));
    return kept * vig;
  }

  // ============================================================================
  // VOLUME HOLO (uSolidMode == 0): a camera-facing deep hologram inside the volume, seen through Snell refraction
  // across the rotating dark-glass facets and bevels.
  // ============================================================================
  vec3 evalRefractedCoreHologram(vec3 worldPos, vec3 worldV, vec3 refrWorld, vec3 entryObj, vec3 refrDirObj) {
    // Camera-facing holographic stage suspended inside the center of the shape
    vec3 baseN = normalize(
      uCamFwd
      + uCamRight * uCoreTilt.x
      + uCamUp * uCoreTilt.y
    );
    vec3 stageT = normalize(uCamRight - baseN * dot(baseN, uCamRight));
    vec3 stageB = normalize(cross(baseN, stageT));
    vec3 stageN = baseN;

    vec3 relWorld = worldPos - uHeroCenter;
    vec3 pStage = vec3(dot(relWorld, stageT), dot(relWorld, stageB), dot(relWorld, stageN));
    vec3 dStage = vec3(dot(refrWorld, stageT), dot(refrWorld, stageB), dot(refrWorld, stageN));
    float vzIn = max(-dStage.z, 0.25);

    float tRefract = clamp(pStage.z, 0.15, 1.15) * 0.42 / vzIn;
    vec2 hitXY = pStage.xy + dStage.xy * tRefract;

    float stageDiam = 1.54;
    vec2 st = hitXY / stageDiam + 0.5;
    vec2 off = (-dStage.xy / vzIn) * 0.28;

    float maxOuterR = 1.6;
    float rNorm = length(st - 0.5) * 2.0;
    float corePlateMask = 1.0 - smoothstep(maxOuterR - 0.04, maxOuterR + 0.04, rNorm);
    if (corePlateMask <= 0.001) return vec3(0.0);

    float aaPlate = clamp(fwidth(st.x) + fwidth(st.y), 0.0007, 0.02);
    float edgeFade = smoothstep(0.02, 0.14, maxOuterR - rNorm);
    // Keep grating angle near camera-facing first-order window so cyan/orange/violet relief stays vivid!
    vec3 gratV = normalize(mix(worldV, -refrWorld, 0.18));

    vec3 chamber = evalHoloChamber(
      st,
      off,
      aaPlate,
      stageT,
      stageB,
      stageN,
      gratV,
      uCoreSubject,
      mod(uCoreSubject, 6.0),
      maxOuterR,
      edgeFade
    ) * corePlateMask;

    return chamber;
  }

  // The card's plate: a rounded rectangle inside its border (vUv is in units of the card's height); its thin sides are
  // all border. Returns the plate's signed distance, its outward gradient and the chamber's scale (fits the width).
  vec4 evalCardPlateSdf(out float mitreOut, out vec2 edgeDirOut) {
    vec2 q = vUv - 0.5;
    vec2 halfSize = vec2(0.5 * uCardAspect, 0.5) - uCardBorder;
    float rad = max(uCardCorner - uCardBorder, 0.006);
    vec2 d = abs(q) - halfSize + rad;
    float sd = vFaceP.x < 0.5 ? 1.0 : length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rad;
    bool side = d.x > d.y;
    mitreOut = 0.0;
    edgeDirOut = side ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
    vec2 grad = side ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y));
    return vec4(sd, grad, 2.0 * halfSize.x);
  }

  // The trading card's holographic foil, over silver: diagonal prismatic bands (each band its own grating, so they throw
  // different colours as the card tilts), glitter flakes that glint one at a time, and a raised foil line round the
  // window. sd: distance to the window (positive outside it, in card heights).
  vec3 cardFoil(vec3 worldV, float sd) {
    vec3 Tw = normalize(vWorldFaceT);
    vec3 Bw = normalize(vWorldFaceB);
    vec3 Nw = normalize(cross(Tw, Bw));
    vec3 Vt = vec3(dot(worldV, Tw), dot(worldV, Bw), max(dot(worldV, Nw), 0.2));
    ChamberLights cl = buildChamberLights(Tw, Bw, Nw, Vt);
    vec2 p = vUv;
    // A smooth foil: the grating's direction turns slowly across the card (no engraved bands).
    float f = dot(p, vec2(0.7071, 0.7071));
    float ga = f * 5.0 + valueNoise2D(p * 3.0) * 1.2;
    vec3 col = litFlatGrating(cl, Vt, vec2(cos(ga), sin(ga)), f * 0.6) * 0.45;
    // Glitter: a fraction of fine cells hold a tilted flake.
    vec2 cell = floor(p * 170.0);
    vec2 h = hash22(cell);
    if (h.x < 0.04) {
      vec3 fn = normalize(vec3((hash22(cell + 3.1) - 0.5) * 1.3, 1.0));
      float glint = 0.0;
      for (int i = 0; i < uFour; i++) glint += pow(max(dot(fn, clHt(cl, i)), 0.0), 140.0) * clPower(cl, i);
      vec2 fp = fract(p * 170.0) - 0.5;
      col += spectral(420.0 + 280.0 * h.y) * glint * smoothstep(0.4, 0.1, length(fp)) * 2.0;
    }
    // The raised line round the window.
    float line = 1.0 - smoothstep(0.002, 0.004, abs(sd - 0.009));
    vec2 q = vUv - 0.5;
    float la = atan(q.y, q.x);
    col += litFlatGrating(cl, Vt, vec2(cos(la), sin(la)), 0.0) * line * 1.6;
    return col;
  }

  // Holographic foil markings stamped on the trading card's window, after collectible cards: a name plate along the top,
  // a text box along the bottom with lines of "type", an emblem in the plate, a round seal, and a faint starfield
  // that only catches the light at some angles. rgb: their light; a: how much they cover the hologram.
  float mkBox(vec2 p, vec2 b, float r) { vec2 d = abs(p) - b + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
  float mkStar(vec2 p, float r) {
    float a = atan(p.y, p.x), k = 6.2831853 / 5.0;
    float m = cos(k * 0.5) / cos(mod(a + 1.5707963, k) - k * 0.5);
    return length(p) - r * mix(0.45, 1.0, pow(max(m - 0.81, 0.0) / 0.19, 3.0));
  }
  // Rows of dashes like small type, in a box (p from its top-left corner, x across).
  float mkType(vec2 p, float width, float rows, float lineH, float seed) {
    float row = floor(p.y / lineH);
    if (p.x < 0.0 || p.x > width || row < 0.0 || row >= rows) return 0.0;
    float y = fract(p.y / lineH) - 0.5;
    float word = floor(p.x / 0.022 + hash21(vec2(row, seed)) * 3.0);
    float on = step(0.22, hash21(vec2(word, row + seed * 7.0)));
    float gap = smoothstep(0.0, 0.0015, fract(p.x / 0.022 + hash21(vec2(row, seed)) * 3.0) * 0.022 - 0.003);
    // The last row stops short.
    float end = row == rows - 1.0 ? step(p.x, width * (0.35 + 0.4 * hash21(vec2(seed, 2.0)))) : 1.0;
    return on * gap * end * (1.0 - smoothstep(0.16, 0.26, abs(y)));
  }
  vec4 cardMarks(vec3 worldV, float sd) {
    vec3 Tw = normalize(vWorldFaceT);
    vec3 Bw = normalize(vWorldFaceB);
    vec3 Nw = normalize(cross(Tw, Bw));
    vec3 Vt = vec3(dot(worldV, Tw), dot(worldV, Bw), max(dot(worldV, Nw), 0.2));
    ChamberLights cl = buildChamberLights(Tw, Bw, Nw, Vt);
    vec2 p = vUv - 0.5;
    vec2 hs = vec2(0.5 * uCardAspect, 0.5) - uCardBorder;
    // Antialiased by the footprint along both axes (a grazing view squeezes one of them).
    float aa = max(length(fwidth(p)), 1e-4) * 1.2;
    // Fine type and stars fade out before they get smaller than a couple of pixels, rather than break up.
    float fine = 1.0 - smoothstep(0.0025, 0.006, aa);
    float ink = 0.0, line = 0.0;
    // Name plate.
    vec2 plateC = vec2(-hs.x * 0.22, hs.y - 0.034);
    float plate = mkBox(p - plateC, vec2(hs.x * 0.72, 0.018), 0.008);
    line = max(line, 1.0 - smoothstep(0.0015, 0.0015 + aa, abs(plate)));
    ink = max(ink, 0.35 * (1.0 - smoothstep(0.0, aa, plate)));
    ink = max(ink, fine * mkType(vec2(p.x - (-hs.x + 0.03), (hs.y - 0.025) - p.y), hs.x * 0.75, 1.0, 0.018, 1.0));
    // The emblem at the plate's right: a star in a ring.
    vec2 em = p - vec2(hs.x - 0.04, plateC.y);
    float ring = abs(length(em) - 0.015);
    line = max(line, 1.0 - smoothstep(0.0018, 0.0018 + aa, ring));
    ink = max(ink, 1.0 - smoothstep(0.0, aa, mkStar(em, 0.011)));
    // Text box.
    vec2 boxC = vec2(0.0, -hs.y + 0.06);
    float box = mkBox(p - boxC, vec2(hs.x - 0.035, 0.038), 0.008);
    line = max(line, 1.0 - smoothstep(0.0015, 0.0015 + aa, abs(box)));
    ink = max(ink, 0.18 * (1.0 - smoothstep(0.0, aa, box)));
    ink = max(ink, 0.85 * fine * mkType(vec2(p.x - (-hs.x + 0.05), (boxC.y + 0.027) - p.y), 2.0 * hs.x - 0.12, 3.0, 0.018, 3.0));
    // Seal, overlapping the box's corner: rings and rays.
    vec2 se = p - vec2(hs.x - 0.05, boxC.y + 0.04);
    float sr = length(se);
    float rays = smoothstep(0.55, 0.9, cos(atan(se.y, se.x) * 16.0)) * step(0.011, sr) * step(sr, 0.02);
    float seal = max(max(1.0 - smoothstep(0.0014, 0.0014 + aa, abs(sr - 0.024)), 1.0 - smoothstep(0.001, 0.001 + aa, abs(sr - 0.0205))), rays);
    seal = max(seal, 1.0 - smoothstep(0.0, aa, mkStar(se, 0.009)));
    float sealDisc = 1.0 - smoothstep(0.0, aa, sr - 0.025);
    // Sparse stars over the art, only lit near the mirror angle of each.
    vec2 g = p * 26.0;
    vec2 gc = floor(g);
    vec2 gh = hash22(gc + 17.0);
    float stars = 0.0;
    if (gh.x < 0.12) stars = fine * (1.0 - smoothstep(0.0, aa * 26.0, mkStar(fract(g) - 0.5 - (gh - 0.5) * 0.3, 0.14 + 0.1 * gh.y)));
    float a = atan(p.y, p.x);
    vec3 col = litFlatGrating(cl, Vt, vec2(cos(a), sin(a)), 0.0) * (line * 1.4 + ink * 0.9 + seal * 1.6);
    col += litFlatGrating(cl, Vt, normalize(se + 1e-4), sr * 6.0) * sealDisc * 0.35;
    float f = dot(p, vec2(0.6, -0.8)) * 60.0;
    col += litFlatGrating(cl, Vt, vec2(0.6, -0.8), fract(f) * 0.3) * stars * 1.2;
    // And all of it softens toward grazing views, where foil shows little anyway.
    float face = smoothstep(0.15, 0.45, abs(dot(worldV, Nw)));
    col *= face;
    float cover = face * clamp(max(max(line, ink), max(seal, sealDisc * 0.35)), 0.0, 1.0) * (1.0 - smoothstep(-0.004, 0.0, sd));
    return vec4(col * (1.0 - smoothstep(-0.004, 0.0, sd)), cover);
  }

  vec4 evalPolygonPlateSdf(float cornerRadiusBase, out float mitreOut, out vec2 edgeDirOut) {
    vec2 p = vUv - 0.5;
    float sides = max(vFaceP.x, 3.0);
    float phase = vFaceP.y;
    float rho = vFaceP.z;
    float bevelW = vFaceP.w;

    float sector = TAU / sides;
    float ang = atan(p.y, p.x + 1e-7) - phase;
    float turn = floor(ang / sector + 0.5) * sector;
    float a = ang - turn;
    float r = length(p);
    vec2 qFold = vec2(r * cos(a), r * sin(a));
    float tanHalf = tan(sector * 0.5);
    mitreOut = abs(a) / (sector * 0.5);

    float band = uFrameBand * rho + bevelW;
    float cornerRad = cornerRadiusBase * rho;
    float inner = max(0.5 - band - cornerRad, 0.005);

    vec2 qBox = vec2(qFold.x - inner, abs(qFold.y) - inner * tanHalf);
    vec2 outV = max(qBox, 0.0);
    float lo = length(outV);
    float sd = lo + min(qBox.x, 0.0) - cornerRad;

    vec2 gFold = (lo > 1e-5 ? outV / lo : vec2(1.0, 0.0)) * vec2(1.0, sign(qFold.y));
    float baseAng = turn + phase;
    float cb = cos(baseAng), sb = sin(baseAng);
    vec2 grad = vec2(gFold.x * cb - gFold.y * sb, gFold.x * sb + gFold.y * cb);
    edgeDirOut = vec2(-sb, cb);
    return vec4(sd, grad.x, grad.y, max(1.0 - band * 2.0, 0.08));
  }

  // ============================================================================
  // Outer Glass Surface Wear: 3 Scratch Layers + Dust Specks + Lint Fibres + Smudges
  // ============================================================================
  vec3 evalGlassWear(
    vec2 surfUv,
    float faceId,
    vec3 Tw,
    vec3 Bw,
    vec3 Nw,
    vec3 Vw,
    out vec2 grooveBumpOut,
    out float scuffOut
  ) {
    grooveBumpOut = vec2(0.0);
    scuffOut = 0.0;
    if (uWear <= 0.001) return vec3(0.0);

    vec3 Vt = vec3(dot(Vw, Tw), dot(Vw, Bw), dot(Vw, Nw));
    vec2 near = (fract(surfUv) - 0.5) * 0.60;

    ChamberLights cl = buildChamberLights(Tw, Bw, Nw, Vt);
    vec2 hs0 = clHt(cl, 0).xy + near;
    vec2 hs1 = clHt(cl, 2).xy + near;
    vec2 hs2 = clHt(cl, 3).xy + near;
    float hp0 = clPower(cl, 0);
    float hp1 = clPower(cl, 2);
    float hp2 = clPower(cl, 3);

    float glint = 0.0;
    float cover = 0.0;

    vec2 fwUv = fwidth(surfUv);
    // 3 curved micro-scratch layers matching holo.ts (17, 6, 1.7)
    for (int sL = 0; sL < uThree; sL++) {
      float cells = (sL == 0) ? 17.0 : ((sL == 1) ? 6.0 : 1.7);
      float seed = (sL == 0) ? 3.7 : ((sL == 1) ? 17.3 : 41.9);
      float lenMin = (sL == 0) ? 0.15 : ((sL == 1) ? 0.12 : 0.50);
      float lenMax = (sL == 0) ? 0.90 : 1.00;
      float curveAmt = (sL == 0) ? 0.50 : ((sL == 1) ? 0.35 : 0.60);
      float gain = (sL == 0) ? 0.60 : ((sL == 1) ? 1.00 : 0.90);

      vec2 p = surfUv * cells;
      vec2 base = floor(p) + vec2(faceId * 37.0 + seed, faceId * 17.0 + seed * 1.7);
      vec2 f = fract(p);
      float px = max(length(fwUv * cells) * 0.70, 0.002);
      float w0 = cells * 0.00045;

      for (int j = -uOne; j <= uOne; j++) {
        for (int i = -uOne; i <= uOne; i++) {
          vec2 o = vec2(float(i), float(j));
          vec4 ra = hash42(base + o);
          vec2 d0 = vec2(ra.z * 2.0 - 1.0, fract(ra.z * 13.7) * 2.0 - 1.0);
          vec2 dir = d0 / max(length(d0), 0.001);
          float L = mix(lenMin, lenMax, ra.w * ra.w);
          vec2 pa = f - (o + ra.xy);
          float h = dot(pa, dir);
          if (abs(h) < L) {
            vec4 rb = hash42(base + o + 57.3);
            if (rb.z < 0.50) {
              vec2 perp = vec2(-dir.y, dir.x);
              float bend = (rb.x - 0.5) * curveAmt;
              float q = dot(pa, perp) - bend * (h * h - L * L);
              float hw = w0 * (rb.y + 0.5);
              float line = (1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, abs(q))) * min(hw * 2.0 / px, 1.0);
              float taper = smoothstep(0.0, 0.4, 1.0 - abs(h) / L);
              float m = line * taper * (rb.w * rb.w * 0.85 + 0.15) * gain;
              if (m > 0.002) {
                vec2 tang = normalize(dir + perp * (bend * h * 2.0));
                vec2 across = vec2(-tang.y, tang.x);
                float resp = 0.0;
                vec2 t0 = vec2(dot(hs0, tang), dot(hs0, across));
                vec2 t1 = vec2(dot(hs1, tang), dot(hs1, across));
                vec2 t2 = vec2(dot(hs2, tang), dot(hs2, across));
                resp += hp0 * exp(-110.0 * t0.x * t0.x - 1.6 * t0.y * t0.y);
                resp += hp1 * exp(-110.0 * t1.x * t1.x - 1.6 * t1.y * t1.y);
                resp += hp2 * exp(-110.0 * t2.x * t2.x - 1.6 * t2.y * t2.y);
                glint += m * resp;
                grooveBumpOut += across * sign(q) * m;
                cover += m;
              }
            }
          }
        }
      }
    }

    // 2 dust speck layers (64, 23) + wandering sinusoidal lint fibre (3.2)
    float pxU = max(length(fwidth(surfUv)) * 0.70, 0.0005);
    float dust = 0.0;
    for (int dL = 0; dL < 2 * uOne; dL++) {
      float k = (dL == 0) ? 64.0 : 23.0;
      float seed = (dL == 0) ? 1.3 : 9.1;
      float prob = (dL == 0) ? 0.50 : 0.32;
      float gain = (dL == 0) ? 0.70 : 1.00;
      vec2 p = surfUv * k;
      vec4 r = hash42(floor(p) + vec2(faceId * 29.0 + seed, faceId * 13.0 + seed * 2.3));
      if (r.w < prob) {
        float rad = mix(0.045, 0.16, r.z * r.z);
        vec2 c = r.xy * (1.0 - rad * 2.6) + rad * 1.3;
        float px = pxU * k;
        float d = length((fract(p) - c) * vec2(1.0, r.z * 0.5 + 0.8));
        float soft = max(rad * 0.6, px);
        float sp = (1.0 - smoothstep(rad - soft, rad + soft * 0.3, d))
                 * min((rad / px) * (rad / px), 1.0)
                 * (fract(r.w * 31.7) * 0.7 + 0.3);
        dust += sp * gain;
      }
    }
    dust *= 0.50;

    // Wandering lint fibre
    vec2 lp = surfUv * 3.1;
    vec2 lCid = floor(lp) + vec2(faceId * 23.0 + 4.4, faceId * 11.0 + 5.7);
    vec4 lr = hash42(lCid);
    if (lr.w < 0.38) {
      vec4 lr2 = hash42(lCid + 21.3);
      vec2 ld0 = vec2(lr.z * 2.0 - 1.0, fract(lr.z * 13.7) * 2.0 - 1.0);
      vec2 lDir = ld0 / max(length(ld0), 0.001);
      vec2 lPerp = vec2(-lDir.y, lDir.x);
      float lLen = lr2.x * 0.14 + 0.08;
      vec2 lPa = fract(lp) - (lr.xy * 0.4 + 0.3);
      float lh = dot(lPa, lDir);
      if (abs(lh) < lLen) {
        float lq = dot(lPa, lPerp) - sin(lh * (lr2.y * 14.0 + 9.0) + lr2.z * TAU) * (lr2.w * 0.03 + 0.012);
        float lPx = pxU * 3.1;
        float lHw = 3.1 * 0.0011;
        float lLine = (1.0 - smoothstep(lHw - lPx * 0.5, lHw + lPx, abs(lq))) * min(lHw * 2.0 / lPx, 1.0);
        dust += lLine * smoothstep(0.0, 0.3, 1.0 - abs(lh) / lLen) * 0.40;
      }
    }

    // Soft wiped smudge halo
    float nSm = valueNoise2D(surfUv * 2.6 + vec2(faceId * 5.3, faceId * 2.9));
    float smudge = smoothstep(0.32, 0.82, nSm) * 0.22;

    float flood = 0.04;
    float halo = 0.0;
    for (int i = 0; i < uFour; i++) {
      flood += clPower(cl, i) * max(clLt(cl, i).z, 0.0) * 0.11;
      vec2 hn = clHt(cl, i).xy + near;
      halo += clPower(cl, i) * exp(dot(hn, hn) * -16.0);
    }

    float graze = pow(1.0 - clamp(Vt.z, 0.0, 1.0), 3.0) * 1.6 + 1.0;
    float wearR = 0.60 * uWear;
    scuffOut = (smudge * 0.32 + dust * 0.50 + cover * 0.70 * 0.30) * wearR;

    float worn = (glint * 0.70 * 0.90 + dust * flood + smudge * halo * 0.22) * graze * uWear;
    return vec3(1.0, 0.985, 0.96) * worn;
  }


`;

const surface = /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
    vec3 worldN = normalize(vWorldNormal);
    if (!gl_FrontFacing) worldN = -worldN;
    vec3 worldV = normalize(cameraPosition - vWorldPos);

    vec3 objN = normalize(vObjNormal);
    if (!gl_FrontFacing) objN = -objN;
    vec3 objV = normalize(vObjViewVec);
    holoGraze = 1.0 - smoothstep(0.12, 0.8, abs(dot(worldN, worldV)));
    holoWorldV = worldV;
    holoNormal = worldN;
    vec3 holoBend = refract(-worldV, worldN, 1.0 / max(uGlassIor, 1.05)) + worldV;
    holoScreenShift = vec2(dot(holoBend, uCamRight), dot(holoBend, uCamUp)) * uRefractShift;

    // ---- 1. Plate vs Optional Machined White-Silver Frame ----
    float plateMask = 1.0;
    float chamberMask = 1.0;
    float windowFade = 1.0;
    float chamferLean = 0.0;
    vec2 plateGrad = vec2(0.0);
    float brushStreak = 0.0;
    float plateSpan = 1.0;
    float plateSd = -0.25;

    bool isFaceChambers = HOLO_CARD == 1 || abs(uSolidMode - 1.0) < 0.25;
    bool hasExplicitFrame = uFrameBand > 0.002;

    if (isFaceChambers || hasExplicitFrame) {
        float cornerRad = hasExplicitFrame ? 0.065 : (vFaceP.w < 0.03 ? 0.145 : 0.055);
        float mitre = 0.0;
        vec2 edgeDir = vec2(1.0, 0.0);
#if HOLO_CARD == 1
        vec4 pShape = evalCardPlateSdf(mitre, edgeDir);
#else
        vec4 pShape = evalPolygonPlateSdf(cornerRad, mitre, edgeDir);
#endif
        plateSd = pShape.x;
        plateGrad = pShape.yz;
        plateSpan = pShape.w;

        float softEdge = max(0.0008 * vFaceP.z, fwidth(plateSd));
        chamberMask = 1.0 - smoothstep(-softEdge, 0.0, plateSd);
        // The image fades out over the last stretch inside the window (as a plate's emulsion thins to its edge), so a part
        // running past the frame doesn't end in a hard line along it.
        windowFade = smoothstep(0.0, 0.18, -plateSd);

        // When Metal Frame is Off on smoothed polyhedra, keep bevels in continuous dark glass!
        // Only show silver corner tips when edges are crisp (bevelW < 0.03) or when Metal Frame > 0.
        float metalBlend = hasExplicitFrame ? 1.0 : (1.0 - smoothstep(0.018, 0.042, vFaceP.w));
        plateMask = mix(1.0, chamberMask, metalBlend);

        if (hasExplicitFrame) {
          chamferLean = (1.0 - smoothstep(0.0, 0.012 * vFaceP.z, abs(plateSd))) * 0.65;
        }

        if (plateMask < 0.999) {
          float grainFade = 1.0 - smoothstep(0.55, 0.98, mitre);
          vec3 grainO = normalize(vObjFaceT.xyz * edgeDir.x + vObjFaceB * edgeDir.y);
          vec3 spot = vObjPos * 420.0;
          vec3 drawn = spot - grainO * dot(spot, grainO) * 0.97;
          float fine = 1.0 - smoothstep(0.35, 1.2, length(fwidth(spot)));
          brushStreak = (valueNoise2D(drawn.xy + drawn.z * 0.7) - 0.5) * 2.0 * fine * grainFade;
        }
    }

    // ---- 2. Deep 5-Layer Hologram Evaluation ----
    vec3 holoRadiance = vec3(0.0);
    if (chamberMask > 0.001) {
      if (isFaceChambers) {
        // Exact solid.ts per-face deep 5-layer holographic chamber!
        float faceIdx = vObjFaceT.w;
        vec3 Tw = normalize(vWorldFaceT);
        vec3 Bw = normalize(vWorldFaceB);
        vec3 Nw = normalize(cross(Tw, Bw));

        vec3 refrWorld = refract(-worldV, worldN, 1.0 / max(uGlassIor, 1.05));
        float bevelBlend = smoothstep(0.998, 0.92, abs(dot(worldN, Nw))) * 0.45;
        vec3 effV = normalize(mix(worldV, -refrWorld, bevelBlend));

        vec3 Vt = vec3(dot(effV, Tw), dot(effV, Bw), max(dot(effV, Nw), 0.22));
        vec2 st = (vUv - 0.5) / plateSpan + 0.5;
        vec2 off = Vt.xy / max(Vt.z, 0.22) / plateSpan;
        float aaPlate = clamp(fwidth(st.x) + fwidth(st.y), 0.0006, 0.025);
        float edgeFade = smoothstep(0.01, 0.10, -plateSd);

        // Shift subject index so the front hero facet displays Subject 0 (3D Bolted Gyroscope)!
        float subjIdx = mod(faceIdx + 7.0, 8.0);
        vec3 layers = evalHoloChamber(
          st,
          off,
          aaPlate,
          Tw,
          Bw,
          Nw,
          effV,
          subjIdx,
          mod(faceIdx + 5.0, 6.0),
          2.05,
          edgeFade
        ) * chamberMask * windowFade;

        // Soft holographic edge hairline matching solid_props.ts (hairline: 0.14, hairlineWidth: 0.028)
        float rho = vFaceP.z;
        float px = max(fwidth(plateSd), 1e-5);
        float hWidth = (hasExplicitFrame ? 0.005 : 0.024) * rho;
        float hInset = (hasExplicitFrame ? 0.012 : 0.014) * rho;
        float hw = hWidth * 0.5;
        float dLine = abs(plateSd + hInset);
        float lineMask = (1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, dLine)) * min(hWidth / px, 1.0);
        if (lineMask > 0.002) {
          ChamberLights cl = buildChamberLights(Tw, Bw, Nw, Vt);
          float fa = atan(st.y - 0.5, st.x - 0.5);
          vec3 lineCol = mix(vec3(0.75), litFlatGrating(cl, Vt, vec2(cos(fa), sin(fa)), 0.0) + 0.25, 0.61) * lineMask;
          layers += lineCol * (hasExplicitFrame ? 0.75 : 0.16);
        }

        holoRadiance = layers;
      } else {
        // Option D: Continuous solid dark-glass crystal with Snell-refracted 5-layer interior core!
        vec3 refrWorld = refract(-worldV, worldN, 1.0 / max(uGlassIor, 1.05));
        vec3 refrDirObj = refract(-objV, objN, 1.0 / max(uGlassIor, 1.05));
        holoRadiance = evalRefractedCoreHologram(vWorldPos, worldV, refrWorld, vObjPos, refrDirObj) * chamberMask;
      }

      // Final hologram saturation, optional tint, and brightness
      float lum = dot(holoRadiance, vec3(0.2126, 0.7152, 0.0722));
      vec3 toned = mix(mix(vec3(lum), holoRadiance, uHoloSaturation), uTintColor * (lum * 2.4), uTintMix);
      holoRadiance = max(toned, vec3(0.0)) * uHoloBrightness;
    }

    // ---- 3. Outer Dark Smoked Optical Glass + Glass Wear + Optional Brushed White-Silver Frame ----
    vec3 wT = normalize(vWorldFaceT - worldN * dot(worldN, vWorldFaceT));
    vec3 wB = normalize(cross(worldN, wT));

    vec2 wearUv = vUv;
    float wearFaceId = vObjFaceT.w;
    vec2 grooveBump = vec2(0.0);
    float scuff = 0.0;
    vec3 wearLight = evalGlassWear(wearUv, wearFaceId, wT, wB, worldN, worldV, grooveBump, scuff) * plateMask;

    // Greasy fingerprints (smudge.js): rougher along their ridges, a faint relief, and a light film over the hologram.
    vec2 guv = vUv * 1.15 + vObjFaceT.w * vec2(0.37, 0.61);
    float gd = 1.0 / 1024.0;
    float grease = clamp(texture(uSmudge, guv).r * 1.6 * uSmudgeAmount, 0.0, 1.0);
    vec2 greaseSlope = vec2(texture(uSmudge, guv + vec2(gd, 0.0)).r - texture(uSmudge, guv - vec2(gd, 0.0)).r,
                            texture(uSmudge, guv + vec2(0.0, gd)).r - texture(uSmudge, guv - vec2(0.0, gd)).r) * uSmudgeAmount;
    grooveBump += greaseSlope * 0.35;
    scuff += grease * 0.25;
    holoRadiance *= 1.0 - 0.15 * grease;

    vec3 perturbedN = normalize(
      worldN
      - (wT * plateGrad.x + wB * plateGrad.y) * chamferLean
      + (wT * grooveBump.x + wB * grooveBump.y) * (0.35 * uWear * plateMask)
    );

    float metal = 1.0 - plateMask;
    s.normal = perturbedN;
    s.albedo = mix(uSubstrateColor, uEdgeColor * (1.0 + brushStreak * 0.08), metal);
    s.metalness = metal;
#if HOLO_CARD == 1
    float frameRough = 0.18;
#else
    float frameRough = 0.38;
#endif
    s.roughness = mix(clamp(uGlassRoughness + scuff, 0.03, 1.0), clamp(frameRough + brushStreak * 0.14, 0.08, 0.9), metal);
    s.specular = mix(uPlateReflection / 0.3, 1.0, metal);
    s.emissive = (holoRadiance + wearLight) * uHoloGain;
#if HOLO_CARD == 1 && HOLO_CARD_STYLE == 1
    if (vFaceP.x < 0.5) {
      // The cut edge: white card stock.
      s.albedo = vec3(0.8, 0.78, 0.74);
      s.metalness = 0.0;
      s.roughness = 0.75;
      s.specular = 0.5;
      s.emissive = vec3(0.0);
    } else {
      s.albedo = mix(uSubstrateColor, vec3(0.8), metal);
      s.roughness = mix(s.roughness, 0.22, metal);
      s.emissive += cardFoil(worldV, plateSd) * (metal * uFoil);
      vec4 marks = cardMarks(worldV, plateSd);
      // Embossed: the markings stand a little proud of the surface (a bump from their coverage, by screen derivatives).
      vec3 dpx = dFdx(vWorldPos), dpy = dFdy(vWorldPos);
      vec3 r1 = cross(dpy, s.normal), r2 = cross(s.normal, dpx);
      float det = dot(dpx, r1);
      float emboss = marks.a * 0.0012 * (1.0 - metal) * smoothstep(0.35, 0.6, abs(dot(worldV, s.normal)));
      vec3 grad = sign(det) * (dFdx(emboss) * r1 + dFdy(emboss) * r2);
      s.normal = normalize(abs(det) * s.normal - grad);
      s.emissive = s.emissive * (1.0 - 0.6 * marks.a * (1.0 - metal)) + marks.rgb * ((1.0 - metal) * uFoil * uHoloGain * 2.0);
    }
#elif HOLO_CARD == 1 && HOLO_CARD_STYLE == 2
    // Glass all over: no frame; the polished edges faintly green, as thick glass is.
    s.metalness = 0.0;
    s.albedo = vFaceP.x < 0.5 ? vec3(0.015, 0.05, 0.035) : uSubstrateColor;
    s.roughness = clamp(0.02 + scuff, 0.02, 1.0);
    s.specular = vFaceP.x < 0.5 ? 1.6 : uPlateReflection / 0.3;
#endif
    holoMetal = s.metalness;
    {
      // The lamp's reflection: a tight core and a soft halo, white on the glass, rainbow on the foil; only on the side it
      // lights.
      vec3 Lt = normalize(uLights[3]);
      float nh = max(dot(s.normal, normalize(Lt + worldV)), 0.0);
      float spot = (pow(nh, 3000.0) * 2.5 + pow(nh, 300.0) * 0.15) * step(0.0, dot(s.normal, Lt));
      vec3 tint = mix(vec3(1.0, 0.97, 0.92), spectral(430.0 + 260.0 * fract(dot(vUv, vec2(2.3, 1.7)) + nh * 6.0)) * 1.3, s.metalness);
      s.emissive += tint * spot * uTorchGain;
    }
#endif
}

`;

// The tunnel in the glass, its range compressed: through a few percent of reflection the walls' dim fill and lit tiles
// would vanish while their bright lines still clip, so the dim parts are lifted more than the bright ones.
const traceReflection = /* glsl */ `
uniform float uReflectLift;
vec4 traceReflection(vec3 P, vec3 R, float rough) {
  vec3 c = traceTunnel(P, R, rough);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lift = uReflectLift * (1.0 - holoMetal);
  return vec4(c * (1.0 + lift) / (1.0 + lift * l * 0.5), 1.0);
}
`;

// The uniforms every variant shares.
export function createHologramUniforms({ portal, replays, look = "spectrum" } = {}) {
  const initial = LOOK_PRESETS[look] || LOOK_PRESETS.spectrum;
  return {
    uPortal: { value: portal },
    uReplay0: { value: replays[0] },
    uReplay1: { value: replays[1] },
    uReplay2: { value: replays[2] },
    uBandT: { value: new Array(12).fill(0) },
    uBandCount: { value: 1 },
    uLambda0: { value: 575 },
    uBandwidth: { value: 35 },
    uSwelling: { value: 1 },
    uSwellSeed: { value: new Vector3() },
    uDisperse: { value: 0.7 },
    uBandStep: { value: new Vector3() },
    uPortalNear: { value: 6 },
    uPortalSpan: { value: 3 },
    uProj: { value: new Vector2(0.5, 0.5) },
    uScreen: { value: new Vector2(1, 1) },
    uRefractShift: { value: 0.015 },

    uModelRot: { value: new Matrix3() },
    uHeroCenter: { value: new Vector3() },
    uCamRight: { value: new Vector3(1, 0, 0) },
    uCamUp: { value: new Vector3(0, 1, 0) },
    uCamFwd: { value: new Vector3(0, 0, 1) },
    uCoreTilt: { value: new Vector2(0, -0.02) },
    uCoreSubject: { value: 0 },

    uTime: { value: 0 },
    uMarchSteps: { value: 28 },
    uRaySteps: { value: 48 },
    uOne: { value: 1 },
    uThree: { value: 3 },
    uFour: { value: 4 },

    // Lights for the grating, in the camera's frame (main.js): key, back, top and a lamp just above the camera.
    uLights: { value: [new Vector3(0.42, 0.46, 0.782).normalize(), new Vector3(-0.52, 0.31, -0.795).normalize(), new Vector3(-0.26, 0.93, 0.258).normalize(), new Vector3(0.1, 0.18, 0.978).normalize()] },
    uLightPower: { value: [1.18, 0.3, 0.38, 0.95] },

    uSubstrateColor: { value: new Color("#040508") },
    uEdgeColor: { value: new Color("#ffffff") },
    uTintColor: { value: new Color(initial.tintColor) },

    uRampMix: { value: initial.rampMix },
    uRampCycles: { value: initial.rampCycles },
    uRamp1: { value: new Color(initial.stops[0]) },
    uRamp2: { value: new Color(initial.stops[1]) },
    uRamp3: { value: new Color(initial.stops[2]) },
    uRamp4: { value: new Color(initial.stops[3]) },
    uRamp5: { value: new Color(initial.stops[4]) },

    uSpacing: { value: initial.spacing },
    uOrder2: { value: initial.order2 },
    uOrder3: { value: initial.order3 },
    uHueShift: { value: initial.hueShift },
    uHoloBrightness: { value: initial.holoBrightness },
    uHoloSaturation: { value: initial.holoSaturation },
    uPurity: { value: initial.purity },
    uSoftClip: { value: initial.softClip },
    uTintMix: { value: initial.tintMix },

    uGlassIor: { value: initial.glassIor },
    uDepthScale: { value: 1 },
    uRingAmount: { value: 1 },
    uBowlDepth: { value: 1 },
    uRingCount: { value: 9 },
    uRingDash: { value: 0.6 },
    uRingTrack: { value: 0 },
    uBraggWidth: { value: 0.3 },
    uFrameBand: { value: 0 },
    uPlateReflection: { value: initial.plateReflection },
    uWear: { value: initial.wear },
    uGlassRoughness: { value: 0.06 },
    uHoloGain: { value: 1 },
    uHaze: { value: 0.25 },
    uGhost: { value: 0.6 },
    uZone: { value: 0.9 },
    uGraze: { value: 1 },
    uCardAspect: { value: 1 },
    uCardBorder: { value: 0.06 },
    uCardCorner: { value: 0.04 },
    uFoil: { value: 1 },
    uSmudge: { value: null },
    uSmudgeAmount: { value: 1 },
    uReflectLift: { value: 0 },
    uTorchGain: { value: 1 },
  };
}

// One program per mode (0 volume, 1 faces, 2 3D), and one per card style (1 trading card, 2 glass plate).
export function createHologramMaterial(uniforms, { mode = 0, card = 0 } = {}) {
  return new PipelineMaterial({
    color: 0x040508,
    roughness: 0.06,
    metalness: 0,
    vertexPars,
    vertexMain,
    varyings,
    // The glass and foil reflect the tunnel round them, traced per pixel.
    fragmentPars: fragmentPars + TUNNEL_TRACE_GLSL + traceReflection,
    reflections: true,
    surface,
    uniforms,
    defines: { HOLO_MODE: card ? 1 : mode, HOLO_CARD: card ? 1 : 0, HOLO_CARD_STYLE: card },
  });
}
