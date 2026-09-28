/**
 * The two Inkt typefaces, bundled rather than fetched: the Electron CSP allows fonts only
 * from 'self', and both apps have to look right offline. Vite copies the woff2 files next to
 * the bundle, so the desktop build and the phone build each carry their own copy.
 *
 * Imported by every entry point (main, quickadd, jarvis, and the phone's main).
 */

// Bricolage with its optical-size axis, so a 112px timer and a 22px logo each get the cut
// drawn for their size.
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import '@fontsource-variable/figtree'
