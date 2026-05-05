export type Sentiment = 'positive' | 'negative' | 'neutral';

export type ProjectSentiment = Sentiment | 'mixed';

export type NarrativeAction = 'encode-as-pattern' | 'generate-corrective-prompt';

export function actionForSentiment(s: Sentiment): NarrativeAction | null {
  if (s === 'positive') return 'encode-as-pattern';
  if (s === 'negative') return 'generate-corrective-prompt';
  return null;
}
