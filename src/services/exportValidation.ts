import type { StoredNamedScene, StoredScene } from './sceneStorage';

export interface ProjectScene {
  id: string;
  objects: StoredNamedScene['objects'];
  sceneOptions: StoredNamedScene['sceneOptions'];
}

export interface SceneExportIssue {
  sceneId: string;
  sceneName: string;
  reasons: string[];
}

/** Error carrying every non-exportable scene so the UI can report them in one shot. */
export class ExportValidationError extends Error {
  readonly issues: SceneExportIssue[];

  constructor(issues: SceneExportIssue[]) {
    super(
      issues.length === 1
        ? `Scene "${issues[0].sceneName}" cannot be exported: ${issues[0].reasons.join('; ')}`
        : `${issues.length} scenes cannot be exported:\n${issues
            .map(issue => `• ${issue.sceneName}: ${issue.reasons.join('; ')}`)
            .join('\n')}`
    );
    this.name = 'ExportValidationError';
    this.issues = issues;
  }
}

/** Flatten a project snapshot into its ordered scenes, the active scene always first. */
export function collectProjectScenes(snapshot: StoredScene): ProjectScene[] {
  const scenes: ProjectScene[] = [
    { id: snapshot.activeSceneId ?? 'initial', objects: snapshot.objects, sceneOptions: snapshot.sceneOptions },
    ...(snapshot.otherScenes ?? []).map(scene => ({ id: scene.id, objects: scene.objects, sceneOptions: scene.sceneOptions }))
  ];
  if (snapshot.sceneOrder) {
    const rank = (id: string) => {
      const index = snapshot.sceneOrder!.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    scenes.sort((a, b) => rank(a.id) - rank(b.id));
  }
  return scenes;
}

/**
 * Validate every scene before any export work starts. All problems are collected, so the
 * user sees every failing scene and reason instead of the first error only.
 */
export function validateProjectForExport(snapshot: StoredScene): SceneExportIssue[] {
  const issues: SceneExportIssue[] = [];
  for (const scene of collectProjectScenes(snapshot)) {
    const reasons: string[] = [];
    const missingModels = scene.objects.filter(obj => obj.type === 'model' && !obj.properties.modelData);
    for (const obj of missingModels) {
      reasons.push(`model "${obj.name}" is missing its original GLB data; import it again`);
    }
    if (scene.sceneOptions.activeCameraId &&
        !scene.objects.some(obj => obj.id === scene.sceneOptions.activeCameraId && obj.type === 'camera')) {
      reasons.push('selected play camera is unavailable; choose another camera');
    }
    if (reasons.length) {
      issues.push({ sceneId: scene.id, sceneName: scene.sceneOptions.name || 'Unnamed scene', reasons });
    }
  }
  return issues;
}
