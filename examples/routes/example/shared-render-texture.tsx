import {
  CanvasView,
  RenderContext,
  ThreeRenderTexture,
  ThreeScene,
} from "@astralarium/pixi-three";
import { type ThreeElements } from "@react-three/fiber";
import { createFileRoute } from "@tanstack/react-router";
import {
  createContext,
  type PropsWithChildren,
  type RefObject,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Mesh, type Object3D } from "three";
import { type TextureNode } from "three/webgpu";

import { DraggableCube } from "#components/draggable-cube";
import { FadeIn } from "#components/fade-in";

import { Frame } from "./-frame";

export const Route = createFileRoute("/example/shared-render-texture")({
  component: SharedRenderTextureExample,
});

function SharedRenderTextureExample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  return (
    <Frame
      title="Shared Render Texture"
      subtitle="One Three render texture across meshes; drag the green cube, also off a surface"
      sourceUrl="https://github.com/astralarium/pixi-three/blob/main/examples/routes/example/shared-render-texture.tsx"
      canvasRef={canvasRef}
    >
      <RenderContext>
        <CanvasView alpha canvasRef={canvasRef}>
          <FadeIn>
            <ThreeScene>
              <SharedRenderTarget>
                <SurfaceMesh position={[-2, 0.4, 0]}>
                  <planeGeometry args={[1.8, 1.8]} />
                </SurfaceMesh>
                <SurfaceMesh position={[0.2, 0.4, 0]}>
                  <planeGeometry args={[1.8, 1.8]} />
                </SurfaceMesh>
                <SurfaceMesh position={[2.3, 0.4, 0]} rotation-y={-0.5}>
                  <boxGeometry args={[1.3, 1.3, 1.3]} />
                </SurfaceMesh>
              </SharedRenderTarget>
            </ThreeScene>
          </FadeIn>
        </CanvasView>
      </RenderContext>
    </Frame>
  );
}

/** Shared render texture and the registry of meshes displaying it */
interface SharedRenderTargetValue {
  texture: TextureNode;
  /** Meshes receiving events for the texture; each surface registers itself */
  meshesRef: RefObject<Object3D[]>;
}

const SharedRenderTargetContext = createContext<SharedRenderTargetValue | null>(
  null,
);

function SharedRenderTarget({ children }: PropsWithChildren) {
  const [texture, setTexture] = useState<TextureNode | null>(null);
  const meshesRef = useRef<Object3D[]>([]);

  return (
    <>
      {/* Unattached: each surface's material reads the node from context */}
      <ThreeRenderTexture
        ref={setTexture}
        objectRef={meshesRef}
        width={460}
        height={460}
        frameloop="always"
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 5, 5]} intensity={1.5} />
        <DraggableCube color="#22c55e" />
        <mesh position={[1.6, 0, 0]}>
          <boxGeometry args={[0.7, 0.7, 0.7]} />
          <meshStandardMaterial color="#f04d5e" />
        </mesh>
        <gridHelper
          args={[6, 12, "#666", "#333"]}
          rotation-x={Math.PI / 2}
          position-z={-1.5}
        />
      </ThreeRenderTexture>
      {texture && (
        <SharedRenderTargetContext value={{ texture, meshesRef }}>
          {children}
        </SharedRenderTargetContext>
      )}
    </>
  );
}

function SurfaceMesh({
  children,
  ...props
}: ThreeElements["mesh"] & PropsWithChildren) {
  const { texture, meshesRef } = use(SharedRenderTargetContext)!;
  const meshRef = useRef<Mesh>(null!);

  useEffect(() => {
    const meshes = meshesRef.current;
    const mesh = meshRef.current;
    meshes.push(mesh);
    return () => {
      meshes.splice(meshes.indexOf(mesh), 1);
    };
  }, [meshesRef]);

  return (
    <mesh {...props} ref={meshRef}>
      {children}
      <meshBasicNodeMaterial colorNode={texture} />
    </mesh>
  );
}
