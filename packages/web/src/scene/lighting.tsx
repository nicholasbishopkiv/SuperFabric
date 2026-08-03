import { LIGHT } from "./palette";

/**
 * The floor's lighting rig.
 *
 * One directional light plus a strong ambient is why the first pass was flat: with `ambientIntensity
 * 0.6` every surface got most of its brightness from a source with no direction, so the difference
 * between a wall facing the light and a wall facing away was a few percent, and a low-poly scene has
 * nothing but that difference to describe its shapes with.
 *
 * Four sources instead, which is the smallest rig that gives a shape three distinguishable faces:
 *
 * - a **key** light, warm and from the front-right, which is what actually models the buildings;
 * - a **fill** from the opposite side, cool and much weaker, so the shadowed faces are still
 *   *readable* — the point of a fill is that you can see into the shade, not that the shade goes away;
 * - a **hemisphere** light with a warm sky and a concrete-coloured ground, which is the cheapest
 *   honest approximation of bounce off a big pale slab;
 * - a much reduced ambient, purely to keep the darkest crevices from going to black.
 *
 * The warm/cool split is doing real work: it is what separates a lit face from a shaded one by *hue*
 * as well as by value, which survives being looked at from across a room and at low zoom.
 *
 * ## Soft shadows: VSM, not drei's `<SoftShadows>`
 *
 * `<SoftShadows>` was tried first and **does not work on this stack**: it patches
 * `ShaderChunk.shadowmap_pars_fragment` with a PCSS implementation that calls `unpackRGBAToDepth`,
 * which three 0.185 no longer defines. The fragment shader fails to compile, and because the patch is
 * global the casualty is whichever material happens to compile next — in our case the packages', so
 * the boxes silently stopped being drawn at all. If drei fixes it, this is the place to reconsider.
 *
 * What is used instead is three's own variance shadow map (`shadows="variance"` on the `<Canvas>`),
 * whose blur is a property of the shadow map rather than of the material shader: `shadow-radius` on
 * the light below. Same result — edges that spread instead of one hard step — with nothing patched,
 * no frames needed, and no chance of taking an unrelated material down with it.
 */
export function FactoryLights() {
  return (
    <>
      {/* Barely there. Its whole job is to stop a crevice reading as a hole. */}
      <ambientLight intensity={0.15} />

      {/* Bounce: warm from above, concrete from below. */}
      <hemisphereLight args={[LIGHT.sky, LIGHT.bounce, 0.45]} />

      {/* The key. Off the camera's own diagonal on purpose: a light coming from behind the viewer
          flattens everything it hits, which is the other half of why the first pass looked diffuse. */}
      <directionalLight
        position={[22, 17, 5]}
        intensity={2.6}
        color={LIGHT.key}
        castShadow
        shadow-mapSize={[2048, 2048]}
        // The default shadow frustum is a 10-unit box; the floor is far bigger than that, so it has
        // to be widened or buildings on the outer ring cast no shadow at all.
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={-100}
        shadow-camera-far={200}
        // VSM blurs the shadow map itself; this is how wide.
        shadow-radius={5}
        shadow-blurSamples={12}
        shadow-bias={-0.0008}
        shadow-normalBias={0.03}
      />

      {/* The fill. No shadow: a second shadow map for a light this weak buys nothing and costs a
          whole extra depth pass over the scene. */}
      <directionalLight position={[-11, 7, -16]} intensity={0.55} color={LIGHT.fill} />
    </>
  );
}
