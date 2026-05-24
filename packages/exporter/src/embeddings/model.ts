/**
 * v2 default Ollama embedding model. 768-dim. Spec §4.
 *
 * Kept in its own module so `embedDriver.ts` (and any future consumer)
 * can import it without dragging the rest of `embeddings/index.ts`
 * (which re-exports it for the public surface) and risking a cycle
 * with `embedDriver` itself.
 */
export const V2_DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
