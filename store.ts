import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ViewerState,
  DEFAULT_PPI,
  MIN_PPI,
  MAX_PPI,
  LoadedModel,
  Vec3,
} from './types';
import { layoutNewModels, relayoutModels } from './utils/layout';

const VALID_EXTENSIONS = new Set(['obj', 'stl', '3mf']);

const generateModelColor = () => {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 60%, 50%)`;
};

const getDefaultScreenSize = () => ({
  width: typeof window !== 'undefined' ? window.screen.width : 1920,
  height: typeof window !== 'undefined' ? window.screen.height : 1080,
});

// Debounce state for batching simultaneous model dimension updates.
let dimensionUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDimensionUpdates: Record<string, Vec3> = {};

export type ArStatus = 'idle' | 'preparing' | 'ready' | 'error';

export interface ArState {
  isArSupported: boolean;
  arStatus: ArStatus;
  arGenerationRequest: number | null;
  arModelUrl: string | null;
  arUsdzUrl: string | null;
  arFileName: string | null;
  arError: string | null;
  setArSupported: (supported: boolean) => void;
  triggerArGeneration: () => void;
  clearArGenerationRequest: () => void;
  setArModelUrl: (url: string | null) => void;
  setArAsset: (kind: 'usdz' | 'glb', url: string, fileName: string) => void;
  setArError: (message: string) => void;
  closeArSession: () => void;
}

const initialScreen = getDefaultScreenSize();

export const useStore = create<ViewerState & ArState>()(
  persist(
    (set, get) => ({
      models: [],
      selectedModelId: null,
      ppi: DEFAULT_PPI,
      isGridVisible: true,
      isWireframeVisible: false,
      gizmoMode: 'translate',
      rotationSnap: Math.PI / 4,
      sidebarOpen: true,
      is1to1Mode: false,
      isCalibrationModalOpen: false,
      uploadError: null,

      isArSupported: false,
      arStatus: 'idle',
      arGenerationRequest: null,
      arModelUrl: null,
      arUsdzUrl: null,
      arFileName: null,
      arError: null,

      calibrationSettings: {
        resolutionWidth: initialScreen.width,
        resolutionHeight: initialScreen.height,
        diagonalInches: 24,
      },

      modelDimensions: {},
      modelPositions: {},
      modelRotations: {},
      modelScales: {},
      manuallyPositionedModelIds: [],

      addModels: (files) => {
        const validFiles: File[] = [];
        const rejectedNames: string[] = [];

        for (const file of files) {
          const ext = file.name.split('.').pop()?.toLowerCase();
          if (ext && VALID_EXTENSIONS.has(ext)) {
            validFiles.push(file);
          } else {
            rejectedNames.push(file.name);
          }
        }

        const uploadError =
          rejectedNames.length > 0
            ? `Unsupported format (${rejectedNames.join(', ')}). Use .obj, .stl, or .3mf.`
            : null;

        if (validFiles.length === 0) {
          if (uploadError) set({ uploadError });
          return;
        }

        const newModels: LoadedModel[] = validFiles.map((file) => ({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
          color: generateModelColor(),
          visible: true,
        }));

        set((state) => {
          const updatedModels = [...state.models, ...newModels];
          const newRotations = { ...state.modelRotations };
          const newScales = { ...state.modelScales };

          for (const model of newModels) {
            newRotations[model.id] = { x: 0, y: 0, z: 0 };
            newScales[model.id] = { x: 1, y: 1, z: 1 };
          }

          return {
            models: updatedModels,
            selectedModelId: newModels[newModels.length - 1].id,
            modelRotations: newRotations,
            modelScales: newScales,
            uploadError,
          };
        });
      },

      addExampleModel: async () => {
        try {
          const { cubeData } = await import('./cubeData');
          const blob = new Blob([cubeData], { type: 'application/octet-stream' });
          const file = new File([blob], 'Calibration_cube.stl', {
            type: 'application/octet-stream',
          });
          get().addModels([file]);
        } catch (error) {
          console.error('Error loading embedded example model:', error);
          set({ uploadError: 'Failed to load example model.' });
        }
      },

      removeModel: (id) => {
        // Drop any queued dimension updates for this model before the debounce fires.
        delete pendingDimensionUpdates[id];

        set((state) => {
          const model = state.models.find((m) => m.id === id);
          if (model) URL.revokeObjectURL(model.url);

          const newModels = state.models.filter((m) => m.id !== id);
          const { [id]: _dim, ...remainingDimensions } = state.modelDimensions;
          const { [id]: _rot, ...remainingRotations } = state.modelRotations;
          const { [id]: _scale, ...remainingScales } = state.modelScales;
          const { [id]: _pos, ...remainingPositions } = state.modelPositions;
          const remainingAnchorIds = state.manuallyPositionedModelIds.filter(
            (anchorId) => anchorId !== id
          );

          // Synchronous compaction in original order. Manual anchors stay put;
          // only non-anchored models to the right of a gap are shifted, so the
          // result always matches the final model set even on rapid deletes.
          const relaidPositions = relayoutModels({
            modelIds: newModels.map((m) => m.id),
            dimensions: remainingDimensions,
            positions: remainingPositions,
            scales: remainingScales,
            anchorIds: new Set(remainingAnchorIds),
          });

          return {
            models: newModels,
            selectedModelId: state.selectedModelId === id ? null : state.selectedModelId,
            modelDimensions: remainingDimensions,
            modelRotations: remainingRotations,
            modelScales: remainingScales,
            modelPositions: relaidPositions,
            manuallyPositionedModelIds: remainingAnchorIds,
          };
        });
      },

      selectModel: (id) => set({ selectedModelId: id }),

      setPPI: (ppi) => {
        if (typeof ppi === 'number' && Number.isFinite(ppi) && ppi > 0) {
          const clamped = Math.min(MAX_PPI, Math.max(MIN_PPI, ppi));
          set({ ppi: clamped });
        }
      },

      setCalibrationSettings: (settings) =>
        set((state) => ({
          calibrationSettings: { ...state.calibrationSettings, ...settings },
        })),

      toggleGrid: () => set((state) => ({ isGridVisible: !state.isGridVisible })),

      toggleWireframe: () => set((state) => ({ isWireframeVisible: !state.isWireframeVisible })),

      setGizmoMode: (mode) => set({ gizmoMode: mode }),

      setRotationSnap: (angleDeg) =>
        set({
          rotationSnap: angleDeg ? angleDeg * (Math.PI / 180) : null,
        }),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      set1to1Mode: (is1to1) => set({ is1to1Mode: is1to1 }),

      setCalibrationModalOpen: (isOpen) => set({ isCalibrationModalOpen: isOpen }),

      clearUploadError: () => set({ uploadError: null }),

      updateModelDimensions: (id, x, y, z) => {
        pendingDimensionUpdates[id] = { x, y, z };

        if (dimensionUpdateTimer) clearTimeout(dimensionUpdateTimer);

        dimensionUpdateTimer = setTimeout(() => {
          dimensionUpdateTimer = null;
          set((state) => {
            const activeIds = new Set(state.models.map((m) => m.id));
            const validUpdates: Record<string, Vec3> = {};

            for (const [modelId, dim] of Object.entries(pendingDimensionUpdates)) {
              if (activeIds.has(modelId)) {
                validUpdates[modelId] = dim;
              }
            }
            pendingDimensionUpdates = {};

            if (Object.keys(validUpdates).length === 0) {
              return {};
            }

            const newDimensions = {
              ...state.modelDimensions,
              ...validUpdates,
            };

            const newPositions = layoutNewModels({
              modelIds: state.models.map((m) => m.id),
              dimensions: newDimensions,
              positions: state.modelPositions,
              scales: state.modelScales,
            });

            return {
              modelDimensions: newDimensions,
              modelPositions: newPositions,
            };
          });
        }, 50);
      },

      updateModelTransform: (id, transform) => {
        set((state) => {
          const updates: Partial<ViewerState> = {};
          let nextPositions = state.modelPositions;
          let nextScales = state.modelScales;
          let anchorIds = state.manuallyPositionedModelIds;
          let positionChanged = false;
          let scaleChanged = false;

          if (transform.position) {
            const current = state.modelPositions[id];
            const next = transform.position;
            if (
              !current ||
              current.x !== next.x ||
              current.y !== next.y ||
              current.z !== next.z
            ) {
              positionChanged = true;
              nextPositions = { ...state.modelPositions, [id]: next };
              // A genuine user move turns the model into a fixed layout anchor.
              if (!anchorIds.includes(id)) {
                anchorIds = [...anchorIds, id];
              }
            }
          }

          if (transform.rotation) {
            updates.modelRotations = {
              ...state.modelRotations,
              [id]: transform.rotation,
            };
          }

          if (transform.scale) {
            const current = state.modelScales[id];
            const next = transform.scale;
            if (
              !current ||
              current.x !== next.x ||
              current.y !== next.y ||
              current.z !== next.z
            ) {
              scaleChanged = true;
              nextScales = { ...state.modelScales, [id]: next };
            }
          }

          if (!positionChanged && !scaleChanged) {
            return updates;
          }

          // Synchronous, idempotent re-layout from the final state. Because the
          // whole chain is recomputed in one commit, rapid consecutive
          // scale/move operations converge on the final arrangement with no
          // debounce or async callback able to restore stale positions.
          const relaidPositions = relayoutModels({
            modelIds: state.models.map((m) => m.id),
            dimensions: state.modelDimensions,
            positions: nextPositions,
            scales: nextScales,
            anchorIds: new Set(anchorIds),
          });

          updates.modelPositions = relaidPositions;
          updates.modelScales = nextScales;
          updates.manuallyPositionedModelIds = anchorIds;
          return updates;
        });
      },

      setArSupported: (supported) => set({ isArSupported: supported }),
      triggerArGeneration: () =>
        set((state) => {
          if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
          if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);
          return {
            arGenerationRequest: Date.now(),
            arStatus: 'preparing',
            arModelUrl: null,
            arUsdzUrl: null,
            arFileName: null,
            arError: null,
          };
        }),
      clearArGenerationRequest: () => set({ arGenerationRequest: null }),

      setArModelUrl: (url) =>
        set((state) => {
          if (state.arModelUrl && state.arModelUrl !== url) {
            URL.revokeObjectURL(state.arModelUrl);
          }
          return { arModelUrl: url };
        }),

      setArAsset: (kind, url, fileName) =>
        set((state) => {
          if (state.arModelUrl && state.arModelUrl !== url) {
            URL.revokeObjectURL(state.arModelUrl);
          }
          if (state.arUsdzUrl && state.arUsdzUrl !== url) {
            URL.revokeObjectURL(state.arUsdzUrl);
          }
          return kind === 'usdz'
            ? {
                arUsdzUrl: url,
                arModelUrl: null,
                arFileName: fileName,
                arStatus: 'ready',
                arError: null,
              }
            : {
                arModelUrl: url,
                arUsdzUrl: null,
                arFileName: fileName,
                arStatus: 'ready',
                arError: null,
              };
        }),

      setArError: (message) =>
        set({
          arStatus: 'error',
          arError: message,
          arGenerationRequest: null,
        }),

      closeArSession: () =>
        set((state) => {
          if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
          if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);
          return {
            arStatus: 'idle',
            arGenerationRequest: null,
            arModelUrl: null,
            arUsdzUrl: null,
            arFileName: null,
            arError: null,
          };
        }),
    }),
    {
      name: '1to13d-storage',
      partialize: (state) => ({
        ppi: state.ppi,
        calibrationSettings: {
          diagonalInches: state.calibrationSettings.diagonalInches,
        },
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<ViewerState>;
        const screen = getDefaultScreenSize();
        return {
          ...currentState,
          ...persisted,
          calibrationSettings: {
            ...currentState.calibrationSettings,
            ...(persisted.calibrationSettings || {}),
            resolutionWidth: screen.width,
            resolutionHeight: screen.height,
          },
        };
      },
    }
  )
);
