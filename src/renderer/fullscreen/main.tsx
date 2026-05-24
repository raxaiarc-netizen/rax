import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '../index.css'
import './styles.css'

// StrictMode intentionally omitted — it double-invokes every render, effect,
// and store subscription, which doubles the cost of every streaming token in
// a chat with deeply-nested live-updating subscribers.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
