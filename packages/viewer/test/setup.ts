// jsdom doesn't ship IndexedDB. fake-indexeddb installs a spec-compliant
// in-memory implementation as a global (window.indexedDB / global.indexedDB)
// so the viewer's IDB-persistence layer can be exercised in tests.
import 'fake-indexeddb/auto';
