/**
 * The main process logs through the backend's logger, pointed at a file beside the database.
 * Kept as its own module so the rest of main keeps importing `log` from one place.
 */

import { log, setLogFile } from '@backend/log.js'
import { logPath } from './paths.js'

setLogFile(logPath)

export { log }
