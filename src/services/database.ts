import type { StoredScene } from './sceneStorage';

export interface ProjectData {
  id: string;
  name: string;
  description: string;
  sceneData: StoredScene;
  createdAt: string;
  updatedAt: string;
}

export type ProjectInput = Pick<ProjectData, 'name' | 'sceneData'> & { description?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projects${path}`, init);
  if (!response.ok) {
    let message = `Project request failed (${response.status})`;
    if (response.headers.get('content-type')?.includes('application/json')) {
      const body: { error?: string } = await response.json();
      if (body.error) message = body.error;
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function saveProject(project: ProjectInput): Promise<ProjectData> {
  return request('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
}

export function updateProject(id: string, project: ProjectInput): Promise<ProjectData> {
  return request(`/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
}

export function getProjects(): Promise<ProjectData[]> {
  return request('');
}

export function getProject(id: string): Promise<ProjectData> {
  return request(`/${encodeURIComponent(id)}`);
}

export function deleteProject(id: string): Promise<{ deleted: boolean }> {
  return request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
