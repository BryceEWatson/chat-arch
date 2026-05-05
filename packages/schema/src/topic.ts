export interface Topic {
  id: string;
  displayName: string;
  sessionIds: readonly string[];
  projectIds: readonly string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
