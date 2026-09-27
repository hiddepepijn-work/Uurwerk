import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { JarvisCorner } from './features/jarvis/JarvisCorner.js'
import './styles/globals.css'
import './features/jarvis/corner.css'

/** The laptop's Jarvis corner: a transparent window of its own, bottom right. */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JarvisCorner />
  </StrictMode>
)
