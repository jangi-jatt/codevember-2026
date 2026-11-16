// The card's motion blur: the frame's card, through an antialiased mask of its silhouette, blurred by its own turning
// (each pixel traced back onto the card's plane at moments across the shutter) and laid back over the tunnel (which
// blurs itself, in its shader).
import { Scene, Mesh, MeshBasicMaterial, WebGLRenderTarget, HalfFloatType, ShaderMaterial, PlaneGeometry, OrthographicCamera, GLSL3, Color, Vector3, Matrix4 } from "three";

export function createCardOver(renderer, pipeline) {
  const maskScene = new Scene();
  const maskMesh = new Mesh(undefined, new MeshBasicMaterial({ color: 0xffffff }));
  maskMesh.matrixAutoUpdate = false;
  maskMesh.frustumCulled = false;
  maskScene.add(maskMesh);
  const mask = new WebGLRenderTarget(1, 1, { samples: 4 });
  const out = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { tBlurred: { value: null }, tSharp: { value: null }, tMask: { value: mask.texture }, sweep: { value: 0 }, taps: { value: 1 }, radius: { value: 1 }, axis: { value: new Vector3(0, 1, 0) }, centre: { value: new Vector3() }, normal: { value: new Vector3() }, viewProj: { value: new Matrix4() }, invViewProj: { value: new Matrix4() }, camPos: { value: new Vector3() } },
    vertexShader: "out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tBlurred, tSharp, tMask;
      // sweep: how far the card turns about axis (through its centre) during the shutter (radians).
      uniform float sweep;
      // taps: samples across the shutter, about a pixel apart at the card's rim; radius: of the sphere the card turns in.
      uniform int taps;
      uniform float radius;
      uniform vec3 axis, centre, normal, camPos;
      uniform mat4 viewProj, invViewProj;
      in vec2 vUv;
      out vec4 o;
      vec3 turn(vec3 v, float a) { float c = cos(a), s = sin(a); return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c); }
      void main() {
        vec4 card = vec4(0.0);
        float cover = 0.0;
        int n = taps;
        vec4 far = invViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
        vec3 dir = normalize(far.xyz / far.w - camPos);
        // Turning about its centre, the card never leaves its sphere: rays that miss it see only the tunnel.
        vec3 oc = camPos - centre;
        float b = dot(oc, dir), c = dot(oc, oc) - radius * radius;
        if (b * b < c || (b > 0.0 && c > 0.0)) {
          o = texture(tBlurred, vUv);
          return;
        }
        for (int i = 0; i < n; i++) {
          // Where the card was at this moment of the shutter, which point of it this pixel saw, and where that point is
          // in the frame as rendered.
          float a = n == 1 ? 0.0 : sweep * ((float(i) + 0.5) / float(n) - 0.5);
          vec3 nA = turn(normal, a);
          float dn = dot(dir, nA);
          if (abs(dn) < 1e-4) continue;
          vec3 hit = camPos + dir * (dot(centre - camPos, nA) / dn);
          vec4 clip = viewProj * vec4(centre + turn(hit - centre, -a), 1.0);
          vec2 at = clip.xy / clip.w * 0.5 + 0.5;
          if (clip.w <= 0.0 || any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) continue;
          float m = texture(tMask, at).r;
          card += texture(tSharp, at) * m;
          cover += m;
        }
        o = texture(tBlurred, vUv) * (1.0 - cover / float(n)) + card / float(n);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const quadScene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const quadCamera = new OrthographicCamera();
  const prevClear = new Color();
  let card = null;

  return {
    // How far the card turns during the shutter (radians), and about which axis (world, through its centre).
    sweep: 0,
    axis: new Vector3(0, 1, 0),
    setCard(mesh) {
      card = mesh;
    },
    composite(hdr, { camera, width, height }) {
      if (!card?.visible) return hdr;
      if (mask.width !== width || mask.height !== height) {
        mask.setSize(width, height);
        out.setSize(width, height);
      }
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevClear);
      maskMesh.geometry = card.geometry;
      // Into .matrix: render() rebuilds matrixWorld from it.
      maskMesh.matrix.copy(card.matrixWorld);
      renderer.setRenderTarget(mask);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(maskScene, camera);
      material.uniforms.tBlurred.value = hdr;
      material.uniforms.tSharp.value = pipeline.mainTarget.texture;
      const u = material.uniforms;
      u.sweep.value = this.sweep;
      u.axis.value.copy(this.axis);
      u.centre.value.setFromMatrixPosition(card.matrixWorld);
      u.normal.value.setFromMatrixColumn(card.matrixWorld, 2).normalize();
      u.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.invViewProj.value.copy(u.viewProj.value).invert();
      u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      const g = card.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      u.radius.value = (g.boundingSphere.center.length() + g.boundingSphere.radius) * card.matrixWorld.getMaxScaleOnAxis() * 1.02;
      // The card's radius in pixels, at its distance.
      const dist = Math.max(u.centre.value.distanceTo(u.camPos.value), 1e-3);
      const rimPx = (u.radius.value * camera.projectionMatrix.elements[5] * height) / (2 * dist);
      u.taps.value = Math.abs(this.sweep) < 1e-3 ? 1 : Math.min(16, Math.max(2, Math.ceil(Math.abs(this.sweep) * rimPx)));
      renderer.setRenderTarget(out);
      renderer.render(quadScene, quadCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      return out.texture;
    },
  };
}
