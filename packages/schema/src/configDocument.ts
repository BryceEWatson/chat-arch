export type ConfigDocumentKind = 'claude-md' | 'skill' | 'agent' | 'command' | 'settings';
export type ConfigDocumentSource = 'global' | 'project';

export interface ConfigSentence {
  index: number;
  text: string;
  kind: 'heading' | 'bullet' | 'paragraph' | 'permission' | 'hook-command' | 'frontmatter';
  lineRange: { start: number; end: number };
}

export interface ConfigDocument {
  id: string;
  source: ConfigDocumentSource;
  kind: ConfigDocumentKind;
  absolutePath: string;
  projectRoot?: string;
  title: string;
  sentences: readonly ConfigSentence[];
}

export interface ConfigsFile {
  generatedAt: number;
  documents: readonly ConfigDocument[];
}
