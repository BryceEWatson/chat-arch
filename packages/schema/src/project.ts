import type { ProjectSentiment } from './sentiment.js';

export const UNASSIGNED_PROJECT_ID = '__unassigned__';
export const UNASSIGNED_PROJECT_DISPLAY = '[UNASSIGNED]';

export type ProjectSource =
  | 'cli-cwd'
  | 'cloud-projects-json'
  | 'semantic-classifier'
  | 'unassigned';

export interface Project {
  id: string;
  displayName: string;
  discoveredAt: string;
  lastActivityAt: string;
  sessionIds: readonly string[];
  narrativeIds: readonly string[];
  topicIds: readonly string[];
  sentiment: ProjectSentiment;
  source: ProjectSource;
}

export function isUnassignedProject(p: Pick<Project, 'id'>): boolean {
  return p.id === UNASSIGNED_PROJECT_ID;
}
