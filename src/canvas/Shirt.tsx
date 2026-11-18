import { useEffect, useState } from "react";
import { easing } from "maath";
import { useSnapshot } from "valtio";
import { useFrame } from "@react-three/fiber";
import { Decal, useGLTF } from "@react-three/drei";
import { TextureLoader, type Mesh, type MeshStandardMaterial, type Texture } from "three";

import state from "../store";
import { decalFallbackState } from "../store/decalFallback";

type ShirtNodes = {
  T_Shirt_male: Mesh;
};

type ShirtMaterials = {
  lambert1: MeshStandardMaterial;
};

type DecalKind = "logo" | "full";

// Default images shipped in /public, matched to the decal type:
// a small logo image for the chest decal, a full-size texture for the whole shirt.
const FALLBACK_SOURCES: Record<DecalKind, string> = {
  logo: "/threejs.png",
  full: "/full-texture.jpg",
};

// Load a decal texture manually (no suspense) so a broken URL can never
// crash the canvas. On failure, fall back to the matching default image
// from /public and flag the fallback in the runtime-only decalFallbackState.
// Each decal kind is loaded independently: one failing never affects the other.
const useDecalTexture = (url: string, kind: DecalKind): Texture | null => {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTexture(null);

    const loader = new TextureLoader();

    const applyTexture = (tex: Texture, fellBack: boolean) => {
      if (cancelled) return;
      tex.anisotropy = 16;
      setTexture(tex);
      decalFallbackState[kind] = fellBack;
    };

    const loadFallback = () => {
      loader.load(
        FALLBACK_SOURCES[kind],
        (tex) => applyTexture(tex, true),
        undefined,
        // even the bundled default failed: keep the shirt rendered
        // without this decal and still report the fallback
        () => {
          if (!cancelled) decalFallbackState[kind] = true;
        },
      );
    };

    loader.load(
      url,
      (tex) => applyTexture(tex, false),
      undefined,
      loadFallback,
    );

    return () => {
      cancelled = true;
    };
  }, [url, kind]);

  return texture;
};

// Shirt
const Shirt = () => {
  // current state snapshot
  const snap = useSnapshot(state);
  // extract nodes and materials from model
  const { nodes, materials } = useGLTF("/shirt_baked.glb") as unknown as {
    nodes: ShirtNodes;
    materials: ShirtMaterials;
  };

  // load textures (each falls back to its own default image on error)
  const logoTexture = useDecalTexture(snap.logoDecal, "logo");
  const fullTexture = useDecalTexture(snap.fullDecal, "full");

  // update t-shirt color on snapshot updated
  useFrame((_, delta) =>
    easing.dampC(materials.lambert1.color, snap.color, 0.25, delta),
  );

  // current state
  const stateString = JSON.stringify(snap);

  return (
    <group key={stateString}>
      {/* mesh */}
      <mesh
        castShadow
        geometry={nodes.T_Shirt_male.geometry}
        material={materials.lambert1}
        material-roughness={1}
        dispose={null}
      >
        {/* if full texture is showing on t-shirt */}
        {snap.isFullTexture && fullTexture && (
          <Decal
            position={[0, 0, 0]}
            rotation={[0, 0, 0]}
            scale={1}
            map={fullTexture}
          />
        )}

        {/* if logo is showing on t-shirt */}
        {snap.isLogoTexture && logoTexture && (
          <Decal
            position={[0, 0.04, 0.15]}
            rotation={[0, 0, 0]}
            scale={0.15}
            map={logoTexture}
            depthTest={false}
            // depthWrite is applied at runtime by drei Decal / three mesh props
            {...{ depthWrite: true }}
          />
        )}
      </mesh>
    </group>
  );
};

useGLTF.preload("/shirt_baked.glb");

export default Shirt;
