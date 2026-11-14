import {
  RawShaderMaterial,
  GLSL3,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  Scene,
  OrthographicCamera,
  WebGLRenderTarget,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  Matrix3,
  Matrix4,
  Vector2,
  Vector3,
  Vector4,
  Color,
} from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { shGLSL } from "modules/pipeline/studio.js";
import { shader as simplex } from "shaders/perlinSimplex3D.js";

export const MAX_BLOBS = 24;
export const MAX_RIPPLES = 8;

const vertexShader = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

#define MAX_BLOBS ${MAX_BLOBS}
#define MAX_RIPPLES ${MAX_RIPPLES}
#define PI 3.14159265

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler3D sdfTex;
uniform vec3 sdfMin;
uniform float sdfSize;
uniform float sdfStep;
uniform sampler3D sdfTexB;
uniform vec3 sdfMinB;
uniform float sdfSizeB;
uniform float sdfStepB;
uniform float morph;
uniform float heightGain;
uniform mat4 bodyInv;
uniform float bodyScale;
uniform vec4 blobs[MAX_BLOBS];
uniform vec4 blobShapes[MAX_BLOBS];
uniform sampler3D heightTex;
uniform vec3 heightMin;
uniform float heightSize;
uniform vec4 rippleA[MAX_RIPPLES];
uniform float rippleAmp[MAX_RIPPLES];
uniform int rippleCount;
uniform vec4 rippleWave;
uniform float stepScale;
uniform int debugView;
// Loop bounds as uniforms, so D3D's compiler can't unroll the loops (constant bounds compiled for 20 s).
uniform int loopOne;
uniform int shadowSteps;
uniform int aoSteps;
uniform int blobCount;
uniform float film;
uniform float smoothK;
uniform vec4 bound;
uniform mat4 viewProjection;
uniform mat4 cameraWorld;
uniform mat4 projectionInv;
uniform vec3 cameraPos;
uniform vec2 resolution;
uniform float ior;
uniform vec3 absorption;
uniform float backdropDistance;
uniform sampler2D pano;
uniform sampler2D panoB;
uniform mat3 bgRotation; // world direction to the turning background's own frame
uniform float panoMix;
uniform float panoGain;
uniform int maxSteps;

uniform samplerCube envMap;
uniform samplerCube envMapB;
uniform float envMix;
uniform mat3 envRotation;
uniform float envIntensity;
uniform float envMapMaxLod;
uniform vec3 shIrradiance[9];
uniform vec3 lightDirection;
uniform vec3 lightColor;

uniform vec3 objColorA;
uniform vec3 objColorB;
uniform float objRoughness;
uniform float objMetalness;
uniform int objPattern;
uniform vec3 objColorA2;
uniform vec3 objColorB2;
uniform float objRoughness2;
uniform float objMetalness2;
uniform int objPattern2;
uniform float matMix;
uniform float patternScale;
uniform vec3 objCentre;

in vec2 vUv;
out vec4 outColor;

${shGLSL}
${simplex}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Body distance in world units; beyond the baked grid, the distance to its box plus the border value.
float gridSDF(sampler3D tex, vec3 mn, float size, float step, vec3 q) {
  vec3 qc = clamp(q, mn + 0.5 * step, mn + size - 0.5 * step);
  return textureLod(tex, (qc - mn) / size, 0.0).r + length(q - qc);
}

// While the shape changes, the body is the blend of the two fields: a morph.
float objectSDF(vec3 p) {
  vec3 q = (bodyInv * vec4(p, 1.0)).xyz;
  float d = gridSDF(sdfTex, sdfMin, sdfSize, sdfStep, q);
  if (morph > 0.0) d = mix(d, gridSDF(sdfTexB, sdfMinB, sdfSizeB, sdfStepB, q), morph);
  return d * bodyScale;
}

// Coat thickness at object-space q: the film, the simulated wave height, and each
// tap's ripple train: a sharp front running out from the contact point with rings trailing behind it.
float coat(vec3 q) {
  float h = film + heightGain * textureLod(heightTex, (q - heightMin) / heightSize, 0.0).r;
  for (int i = 0; i < rippleCount; i++) {
    vec4 a = rippleA[i];
    float dist = length(q - a.xyz) * bodyScale;
    float x = dist - rippleWave.x * a.w;
    float sigma = x < 0.0 ? rippleWave.y : rippleWave.w;
    h += rippleAmp[i] * exp(-x * x / (2.0 * sigma * sigma)) * cos(rippleWave.z * x) / (1.0 + 0.6 * dist);
  }
  // Troughs thin the coat but never bare the body.
  float floorH = 0.25 * film, soft = 0.25 * film;
  return h > floorH + soft ? h : floorH + soft * exp((h - floorH - soft) / soft);
}

// A blob is an ellipsoid of the same volume, stretched by s.w along s.xyz.
float blobSDF(vec3 p, vec4 b, vec4 s) {
  vec3 v = p - b.xyz;
  float e = 1.0 + s.w;
  float along = dot(v, s.xyz);
  vec3 scaled = s.xyz * (along / e) + (v - s.xyz * along) * sqrt(e);
  return (length(scaled) - b.w) * min(e, inversesqrt(e));
}

float waterSDF(vec3 p, float so) {
  vec3 q = (bodyInv * vec4(p, 1.0)).xyz;
  float d = so - coat(q);
  for (int i = 0; i < blobCount; i++) {
    d = smin(d, blobSDF(p, blobs[i], blobShapes[i]), smoothK);
  }
  return d;
}

float water(vec3 p) { return waterSDF(p, objectSDF(p)); }

vec3 waterNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  float e = 0.5 * sdfStep * bodyScale;
  return normalize(k.xyy * water(p + k.xyy * e) + k.yyx * water(p + k.yyx * e) + k.yxy * water(p + k.yxy * e) + k.xxx * water(p + k.xxx * e));
}

vec3 objectNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  float e = sdfStep * bodyScale;
  return normalize(k.xyy * objectSDF(p + k.xyy * e) + k.yyx * objectSDF(p + k.yyx * e) + k.yxy * objectSDF(p + k.yxy * e) + k.xxx * objectSDF(p + k.xxx * e));
}

// The environment, crossfading to the next background's while it changes.
vec3 env(vec3 d, float lod) {
  vec3 c = textureLod(envMap, envRotation * d, lod).rgb;
  if (envMix > 0.0) c = mix(c, textureLod(envMapB, envRotation * d, lod).rgb, envMix);
  return c * envIntensity;
}

vec2 envBRDFApprox(float r, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r4 = r * c0 + c1;
  float a004 = min(r4.x * r4.x, exp2(-9.28 * NoV)) * r4.x + r4.y;
  return vec2(-1.04, 1.04) * a004 + r4.zw;
}

// Square wave of period 1 (0 on [0, 0.5), 1 on [0.5, 1)), box-filtered over width w.
float square(float x, float w) {
  return clamp((0.25 - abs(fract(x - 0.25) - 0.5)) / max(w, 1e-4) + 0.5, 0.0, 1.0);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float dots2(vec2 s, float w) {
  return smoothstep(0.28 + w, 0.28 - w, length(fract(s) - 0.5));
}

float checker2(vec2 s, float w) {
  float a = square(s.x * 0.5, w * 0.5), b = square(s.y * 0.5, w * 0.5);
  return 0.5 - 0.5 * (1.0 - 2.0 * a) * (1.0 - 2.0 * b);
}

// The finish's print at object-space q with object-space normal n, filtered over fw (the pixel's footprint, object
// units) so edges stay smooth.
float pattern(vec3 q, vec3 n, float fw, int pat) {
  vec3 s = q * patternScale;
  float w = fw * patternScale + 0.012;
  // Triplanar weights, sharpened so the blends between projections stay narrow.
  vec3 tw = pow(abs(n), vec3(6.0));
  tw /= tw.x + tw.y + tw.z;
  if (pat == 1) return square(s.y * 0.5, w * 0.5);
  if (pat == 2) {
    // Spheres on a jittered lattice: any cut through a sphere is a disc.
    vec3 c = floor(s);
    float d = 1e9;
    for (int z = -loopOne; z <= loopOne; z++)
      for (int y = -loopOne; y <= loopOne; y++)
        for (int x = -loopOne; x <= loopOne; x++) {
          vec3 cell = c + vec3(x, y, z);
          vec3 o = cell + 0.5 + 0.5 * (hash33(cell) - 0.5);
          d = min(d, length(s - o));
        }
    return smoothstep(0.3 + w, 0.3 - w, d);
  }
  if (pat == 3) {
    vec3 r = q - objCentre;
    return square(atan(length(r.xz), r.y) / 3.14159265 * patternScale * 1.5, w * 0.5);
  }
  if (pat == 4) return tw.x * dots2(s.yz, w) + tw.y * dots2(s.zx, w) + tw.z * dots2(s.xy, w);
  if (pat == 5) return tw.x * checker2(s.yz, w) + tw.y * checker2(s.zx, w) + tw.z * checker2(s.xy, w);
  vec3 r = q - objCentre;
  float rs = length(r) * patternScale;
  if (pat == 6) {
    // Beach ball: wedges around the vertical axis.
    float u = (atan(r.z, r.x) / 6.2831853 + 0.5) * 6.0;
    float wa = fw / max(length(r.xz), 1e-3) * 6.0 / 6.2831853;
    return square(u * 0.5, wa * 0.5 + 0.01);
  }
  if (pat == 7) {
    // Candy swirl: stripes along the axis, twisted twice per turn.
    float v = s.y * 0.35 + (atan(r.z, r.x) / 6.2831853) * 2.0;
    return square(v, w * 0.35);
  }
  if (pat == 8) {
    // Giraffe: patches parted by the borders of 3D Voronoi cells.
    vec3 c = s * 0.8;
    vec3 i = floor(c);
    float f1 = 1e9, f2 = 1e9;
    for (int z = -loopOne; z <= loopOne; z++)
      for (int y = -loopOne; y <= loopOne; y++)
        for (int x = -loopOne; x <= loopOne; x++) {
          vec3 cell = i + vec3(x, y, z);
          float d = length(c - cell - hash33(cell));
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else f2 = min(f2, d);
        }
    return smoothstep(0.07 - w, 0.07 + w, f2 - f1);
  }
  if (pat == 9) {
    // Camo: thresholded noise in two octaves.
    float n = snoise(s * 0.45) + 0.5 * snoise(s * 1.1 + 7.0);
    return smoothstep(-w, w, n - 0.05);
  }
  if (pat == 10) {
    // Coral: where a gyroid surface cuts the object.
    vec3 g = s * 2.4;
    float d = dot(sin(g), cos(g.yzx)) / 1.5;
    return smoothstep(0.2 + 2.0 * w, 0.2 - 2.0 * w, abs(d));
  }
  if (pat == 12) {
    // Wood: growth rings round a log lying along x, so faces show grain; each ring darkens into its late wood.
    vec3 p = q - objCentre;
    float rr = length(p.yz + 0.03 * vec2(snoise(p * 2.0), snoise(p * 2.0 + 4.0))) * patternScale * 3.5;
    float ring = smoothstep(0.6, 0.95, fract(rr)) * (1.0 - smoothstep(0.95, 1.0, fract(rr)));
    float fibre = 0.5 + 0.5 * snoise(vec3(p.x * 3.0, p.y * 70.0, p.z * 70.0));
    return clamp(ring * 0.8 + fibre * 0.15, 0.0, 1.0);
  }
  if (pat == 13) {
    // Agate: many concentric bands round the centre, gently wavering.
    float d = rs * 2.6 + 0.18 * snoise(q * 1.1) + 0.05 * snoise(q * 5.0);
    return smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(d * 6.2831853));
  }
  if (pat == 14) {
    // Damascus: thin horizontal layers, folded in broad waves.
    float y = s.y * 2.5 + 0.9 * snoise(s * 0.22) + 0.15 * snoise(s * 0.9);
    return smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(y * 6.2831853));
  }
  if (pat == 15) {
    // Marble: soft veins along warped planes over a faint cloudy ground.
    float n = snoise(s * 0.3) + 0.5 * snoise(s * 0.6 + 5.0) + 0.25 * snoise(s * 1.2 + 9.0);
    float v = abs(sin((s.x * 0.5 + s.y * 0.3) * 2.2 + n * 2.0));
    float vein = pow(1.0 - smoothstep(0.0, 0.55, v), 3.0);
    float cloud = 0.5 + 0.5 * snoise(s * 0.5 + 2.0);
    return clamp(vein * 0.85 + 0.2 * cloud, 0.0, 1.0);
  }
  return 0.0;
}

float softShadow(vec3 p, vec3 L) {
  float res = 1.0, t = 0.02 * bodyScale;
  for (int i = 0; i < shadowSteps; i++) {
    float h = objectSDF(p + L * t);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.01 * bodyScale, 0.2 * bodyScale);
    if (res < 0.01 || t > 2.5 * bodyScale) break;
  }
  return clamp(res, 0.0, 1.0);
}

float objectAO(vec3 p, vec3 n) {
  float occ = 0.0, w = 1.0;
  for (int i = 1; i <= aoSteps; i++) {
    float h = 0.04 * float(i) * bodyScale;
    occ += (h - objectSDF(p + n * h)) * w;
    w *= 0.7;
  }
  return clamp(1.0 - 2.5 * occ / bodyScale, 0.0, 1.0);
}

// fw: the pixel's footprint at p (world units).
vec3 shadeObject(vec3 p, vec3 V, float fw) {
  vec3 n = objectNormal(p);
  // The march stops within a tolerance of the body; shade on the surface itself so the print doesn't shift.
  p -= n * objectSDF(p);
  vec3 q = (bodyInv * vec4(p, 1.0)).xyz;
  // While the finish changes, the new one spreads across the body behind a wavering front. Each point takes one
  // finish or the other, so the pattern is compiled once: two calls, or a loop round one, take D3D's compiler seconds.
  vec3 nq = normalize(mat3(bodyInv) * n);
  bool next = matMix > 0.0 && dot(q - objCentre, vec3(0.6, 0.8, 0.0)) + 0.12 * sin(q.x * 7.0 + q.z * 5.0) * sin(q.y * 6.0 - q.z * 3.0) < mix(-1.6, 1.6, matMix);
  vec3 albedo = mix(next ? objColorA2 : objColorA, next ? objColorB2 : objColorB, pattern(q, nq, fw / bodyScale, next ? objPattern2 : objPattern));
  float rough = next ? objRoughness2 : objRoughness, metal = next ? objMetalness2 : objMetalness;
  vec3 diffuseColor = albedo * (1.0 - metal);
  vec3 f0 = mix(vec3(0.02), albedo, metal);
  float NdotV = clamp(dot(n, V), 1e-3, 1.0);
  float ao = objectAO(p, n);

  vec3 L = lightDirection;
  float NdotL = clamp(dot(n, L), 0.0, 1.0);
  vec3 color = vec3(0.0);
  if (NdotL > 0.0) {
    float sh = softShadow(p + n * 0.01 * bodyScale, L);
    vec3 H = normalize(L + V);
    float NdotH = clamp(dot(n, H), 0.0, 1.0), VdotH = clamp(dot(V, H), 0.0, 1.0);
    float a = max(rough * rough, 0.002), a2 = a * a;
    float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float vis = 0.5 / (NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2) + NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2));
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - VdotH, 5.0);
    vec3 E = lightColor * NdotL * sh;
    color += E * (diffuseColor / PI + F * D * vis);
  }
  vec2 dfg = envBRDFApprox(rough, NdotV);
  vec3 spec = f0 * dfg.x + dfg.y;
  vec3 irradiance = max(evalSH(envRotation * n), vec3(0.0)) * envIntensity;
  vec3 R = reflect(-V, n);
  color += diffuseColor * (1.0 - spec) * irradiance * ao;
  color += env(R, envMapMaxLod * rough * (2.0 - rough)) * spec * ao;
  return color;
}

// The cabin: a 360° equirect photo around the scene, fixed in the world, already defocused (backdrop.js).
vec3 backdrop(vec3 d) {
  d = bgRotation * d;
  float elevation = atan(d.y, length(d.xz));
  vec2 uv = vec2(atan(d.x, -d.z) / 6.2831853 + 0.5, 0.5 - elevation / 3.14159265);
  vec3 c = textureLod(pano, uv, 0.0).rgb;
  if (panoMix > 0.0) c = mix(c, textureLod(panoB, uv, 0.0).rgb, panoMix);
  return c * panoGain;
}

// Behind the water: the cabin, along the ray as it leaves.
vec3 behind(vec3 p, vec3 d) {
  return backdrop(d);
}

float fresnel(float c, float n1, float n2) {
  float r = (n1 - n2) / (n1 + n2);
  r *= r;
  return r + (1.0 - r) * pow(1.0 - c, 5.0);
}

vec2 sphereHit(vec3 o, vec3 d, vec4 s) {
  vec3 oc = o - s.xyz;
  float b = dot(oc, d), c = dot(oc, oc) - s.w * s.w, h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// One flat march for the eye ray: to the water, through every interface it meets, until it hits the body or leaves.
// A ray that passes within a pixel's cone of the water without touching it enters at its closest point, and its
// coverage blends it over the frame.
vec4 trace(vec3 o, vec3 d, float t0, float t1) {
  float cone = projectionInv[1][1] * 2.0 / resolution.y;
  float eps = 0.0007 * bodyScale;
  vec3 p = o + d * t0;
  float t = t0;
  vec3 radiance = vec3(0.0), throughput = vec3(1.0);
  bool inside = false, entered = false;
  int reflections = 0, crossings = 0, entries = 0;
  float lastCross = -1e9;
  bool hitBody = false;
  float best = 1e9, travelled = 0.0, coverage = 1.0;
  vec3 bestP = p;
  float bestW = 0.0;
  for (int i = 0; i < maxSteps; i++) {
    float so = objectSDF(p);
    float w = waterSDF(p, so);
    // Surfaces count as hit within half a pixel's footprint, so grazing rays don't crawl.
    float hitEps = max(eps, 0.5 * cone * t);
    // A surface just crossed can't be met again until the ray is clear of it.
    bool clear = t - lastCross > 4.0 * hitEps;
    int event = 0; // 1: into the water, 2: out of it
    if (!inside) {
      if (!entered) {
        float ratio = w / (t * cone);
        if (ratio < best) {
          best = ratio;
          bestP = p;
          bestW = w;
        } else if (best < 1.0 && ratio > best + 0.5) {
          // Clearly moving away after a near miss: enter at the closest point.
          coverage = 1.0 - smoothstep(0.0, 1.0, best);
          p = bestP;
          w = bestW;
          event = 1;
        }
      }
      if (w < hitEps && clear) event = 1;
      if (event == 0) {
        if (entered ? (length(p - bound.xyz) > bound.w && dot(p - bound.xyz, d) > 0.0) : t > t1) break;
        float advance = max(w * stepScale, 0.5 * hitEps);
        p += d * advance;
        t += advance;
        continue;
      }
    } else {
      if (so < hitEps) {
        throughput *= exp(-absorption * travelled);
        hitBody = true;
        break;
      }
      if (-w < hitEps && clear) event = 2;
      if (event == 0) {
        // A floor on the step: rays running along a thin coat would otherwise crawl; hits are snapped back to the surface.
        float advance = max(min(-w * stepScale, so), max(0.5 * hitEps, 0.006 * bodyScale));
        p += d * advance;
        travelled += advance;
        t += advance;
        continue;
      }
    }
    if (++crossings > 8) break;
    lastCross = t;
    // One normal for every crossing, so the compiler inlines the field for it once (it is slow on big shaders).
    vec3 n = waterNormal(p);
    p -= n * w;
    if (event == 1) {
      entries++;
      float F = fresnel(clamp(dot(-d, n), 0.0, 1.0), 1.0, ior);
      radiance += throughput * F * backdrop(reflect(d, n));
      throughput *= 1.0 - F;
      d = refract(d, n, 1.0 / ior);
      p += d * eps - n * max(3.0 * eps, 2.0 * hitEps);
      inside = true;
      entered = true;
      travelled = 0.0;
    } else {
      throughput *= exp(-absorption * travelled);
      travelled = 0.0;
      vec3 r = refract(d, -n, ior);
      // A ray caught bouncing inside a lobe is let out after a few reflections, before it can use up its steps.
      if (reflections >= 3 && dot(r, r) < 1e-6) r = normalize(d + n * 0.5);
      if (dot(r, r) < 1e-6) {
        reflections++;
        d = reflect(d, -n);
        p += d * eps - n * max(3.0 * eps, 2.0 * hitEps);
      } else {
        throughput *= 1.0 - fresnel(clamp(dot(r, n), 0.0, 1.0), 1.0, ior);
        d = r;
        p += d * eps + n * max(3.0 * eps, 2.0 * hitEps);
        inside = false;
      }
    }
  }
  if (!entered) return vec4(0.0);
  if (debugView == 1 && hitBody) return vec4(1, 0, 0, 1);
  if (debugView == 1) return crossings > 8 ? vec4(1, 0, 1, 1) : inside ? vec4(0, 0, 1, 1) : length(p - bound.xyz) > bound.w ? vec4(0, 1, 0, 1) : vec4(1, 1, 0, 1);
  if (debugView == 2) return vec4(float(entries) / 6.0, float(crossings - entries - reflections) / 6.0, float(reflections) / 6.0, 1);
  if (!hitBody && inside) {
    // Out of steps inside the water: the body is usually what the ray was creeping along.
    throughput *= exp(-absorption * travelled);
    // (shadeObject snaps the point onto the body.)
    hitBody = objectSDF(p) < 2.0 * film;
  }
  // Shaded in one place only: the compiler inlines every call.
  if (hitBody) return vec4(radiance + throughput * shadeObject(p, -d, cone * t), coverage);
  return vec4(radiance + throughput * behind(p, d), coverage);
}

void main() {
  vec4 view = projectionInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize((cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  vec2 tb = sphereHit(cameraPos, d, bound);
  vec4 c = tb.y > 0.0 ? trace(cameraPos, d, max(tb.x, 0.0), tb.y) : vec4(0.0);
  outColor = vec4(mix(backdrop(d), c.rgb, c.a), 1.0);
}
`;

export class Water {
  // scale: the trace's resolution relative to the frame; below 1 the water is traced smaller and blended over the
  // full-resolution frame.
  constructor({ scale = 1 } = {}) {
    this.scale = scale;
    this.blobs = Array.from({ length: MAX_BLOBS }, () => new Vector4());
    this.uniforms = {
      tScene: { value: null },
      tDepth: { value: null },
      sdfTex: { value: null },
      sdfMin: { value: new Vector3() },
      sdfSize: { value: 1 },
      sdfStep: { value: 1 },
      sdfTexB: { value: null },
      sdfMinB: { value: new Vector3() },
      sdfSizeB: { value: 1 },
      sdfStepB: { value: 1 },
      morph: { value: 0 },
      heightGain: { value: 1 },
      bodyInv: { value: new Matrix4() },
      bodyScale: { value: 1 },
      blobs: { value: this.blobs },
      blobCount: { value: 0 },
      blobShapes: { value: Array.from({ length: MAX_BLOBS }, () => new Vector4(0, 1, 0, 0)) },
      heightTex: { value: null },
      heightMin: { value: new Vector3() },
      heightSize: { value: 1 },
      rippleA: { value: Array.from({ length: MAX_RIPPLES }, () => new Vector4()) },
      rippleAmp: { value: new Array(MAX_RIPPLES).fill(0) },
      rippleCount: { value: 0 },
      // speed, trailing width, wavenumber, leading width (world units)
      rippleWave: { value: new Vector4(1.1, 0.5, 17, 0.08) },
      stepScale: { value: 1 },
      debugView: { value: 0 },
      loopOne: { value: 1 },
      shadowSteps: { value: 24 },
      aoSteps: { value: 5 },
      film: { value: 0.04 },
      smoothK: { value: 0.12 },
      bound: { value: new Vector4(0, 0, 0, 2) },
      viewProjection: { value: new Matrix4() },
      cameraWorld: { value: new Matrix4() },
      projectionInv: { value: new Matrix4() },
      cameraPos: { value: new Vector3() },
      resolution: { value: new Vector2() },
      ior: { value: 1.333 },
      absorption: { value: new Vector3(0.3, 0.06, 0.04) },
      backdropDistance: { value: 6 },
      pano: { value: null },
      panoB: { value: null },
      bgRotation: { value: new Matrix3() },
      panoMix: { value: 0 },
      panoGain: { value: 1 },
      maxSteps: { value: 160 },
      envMap: globalUniforms.envMap,
      envMapB: { value: null },
      envMix: { value: 0 },
      envRotation: globalUniforms.envRotation,
      envIntensity: globalUniforms.envIntensity,
      envMapMaxLod: globalUniforms.envMapMaxLod,
      shIrradiance: globalUniforms.shIrradiance,
      lightDirection: globalUniforms.lightDirection,
      lightColor: globalUniforms.lightColor,
      objColorA: { value: new Color() },
      objColorB: { value: new Color() },
      objRoughness: { value: 0.3 },
      objMetalness: { value: 0 },
      objPattern: { value: 0 },
      objColorA2: { value: new Color() },
      objColorB2: { value: new Color() },
      objRoughness2: { value: 0.3 },
      objMetalness2: { value: 0 },
      objPattern2: { value: 0 },
      matMix: { value: 0 },
      patternScale: { value: 4 },
      objCentre: { value: new Vector3() },
    };
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene = new Scene().add(this.quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.target.texture.colorSpace = NoColorSpace;
    this.traceTarget = this.target.clone();
    this.blend = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tWater;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(tWater, vUv).rgb, 1.0);
}
`,
      uniforms: { tScene: { value: null }, tWater: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
  }

  // Compiles the trace in the background (parallel shader compile), so the first frame doesn't wait on it.
  compile(renderer) {
    return renderer.compileAsync(this.scene, this.camera);
  }

  // sdf: { texture, min, size, step } from loadSdf().
  setSdf(sdf, second = false) {
    const u = this.uniforms;
    (second ? u.sdfTexB : u.sdfTex).value = sdf.texture;
    (second ? u.sdfMinB : u.sdfMin).value.fromArray(sdf.min);
    (second ? u.sdfSizeB : u.sdfSize).value = sdf.size;
    (second ? u.sdfStepB : u.sdfStep).value = sdf.step;
  }

  // body: the Object3D the shape is drawn with (uniform scale).
  update(body, blobCount) {
    const u = this.uniforms;
    body.updateMatrixWorld();
    u.bodyInv.value.copy(body.matrixWorld).invert();
    u.bodyScale.value = body.scale.x;
    u.blobCount.value = blobCount;
  }

  render(renderer, hdr, { depthTexture, camera, width, height }) {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const split = this.scale < 1;
    const tw = split ? Math.max(1, Math.round(width * this.scale)) : width, th = split ? Math.max(1, Math.round(height * this.scale)) : height;
    if (split && (this.traceTarget.width !== tw || this.traceTarget.height !== th)) this.traceTarget.setSize(tw, th);
    const u = this.uniforms;
    u.resolution.value.set(tw, th);
    u.tScene.value = hdr;
    u.tDepth.value = depthTexture;
    u.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.projectionInv.value.copy(camera.projectionMatrix).invert();
    u.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    const previous = renderer.getRenderTarget();
    this.quad.material = this.material;
    renderer.setRenderTarget(split ? this.traceTarget : this.target);
    renderer.render(this.scene, this.camera);
    if (split) {
      this.blend.uniforms.tScene.value = hdr;
      this.blend.uniforms.tWater.value = this.traceTarget.texture;
      this.quad.material = this.blend;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    }
    renderer.setRenderTarget(previous);
    return this.target.texture;
  }
}
