import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { NotesApp } from './notes/NotesApp'
import './styles.css'

// The same bundle powers the separate Notes window (opened with #notes).
const isNotes = location.hash === '#notes'

createRoot(document.getElementById('root')!).render(<StrictMode>{isNotes ? <NotesApp /> : <App />}</StrictMode>)
