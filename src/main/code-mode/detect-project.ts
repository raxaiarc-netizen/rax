import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { DetectedProject } from '../../shared/types'

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson
  } catch {
    return null
  }
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name])
}

function pickRunner(pkg: PackageJson): { command: string; args: string[]; scriptName: string } | null {
  const scripts = pkg.scripts || {}
  const order = ['dev', 'start:dev', 'develop', 'serve', 'start']
  for (const name of order) {
    if (scripts[name]) {
      return { command: 'npm', args: ['run', name, '--silent'], scriptName: name }
    }
  }
  return null
}

/**
 * Inspect a working directory and figure out how to run it as a dev server.
 *
 * Detection order is intentional — Next/Nuxt/SvelteKit/Astro are checked before
 * the generic Vite branch because they pull Vite in transitively.
 */
export function detectProject(projectPath: string): DetectedProject {
  const pkg = readPackageJson(projectPath)

  if (pkg) {
    const runner = pickRunner(pkg)
    const command = runner?.command || 'npm'
    const args = runner?.args || ['run', 'dev', '--silent']

    if (hasDep(pkg, 'next')) {
      return {
        kind: 'next',
        label: 'Next.js',
        command,
        args,
        fallbackPort: 3000,
        honorsPortEnv: true,
      }
    }
    if (hasDep(pkg, 'nuxt') || hasDep(pkg, 'nuxt3')) {
      return {
        kind: 'nuxt',
        label: 'Nuxt',
        command,
        args,
        fallbackPort: 3000,
        honorsPortEnv: true,
      }
    }
    if (hasDep(pkg, '@sveltejs/kit')) {
      return {
        kind: 'sveltekit',
        label: 'SvelteKit',
        command,
        args,
        fallbackPort: 5173,
        honorsPortEnv: false,
      }
    }
    if (hasDep(pkg, 'astro')) {
      return {
        kind: 'astro',
        label: 'Astro',
        command,
        args,
        fallbackPort: 4321,
        honorsPortEnv: false,
      }
    }
    if (hasDep(pkg, '@angular/core')) {
      return {
        kind: 'angular',
        label: 'Angular',
        command,
        args,
        fallbackPort: 4200,
        honorsPortEnv: false,
      }
    }
    if (hasDep(pkg, 'react-scripts')) {
      return {
        kind: 'cra',
        label: 'Create React App',
        command,
        args,
        fallbackPort: 3000,
        honorsPortEnv: true,
      }
    }
    if (hasDep(pkg, 'vite')) {
      return {
        kind: 'vite',
        label: 'Vite',
        command,
        args,
        fallbackPort: 5173,
        honorsPortEnv: false,
      }
    }
    if (hasDep(pkg, 'electron')) {
      return {
        kind: 'electron',
        label: 'Electron',
        command,
        args,
        fallbackPort: 5173,
        honorsPortEnv: false,
      }
    }

    if (runner) {
      return {
        kind: 'node-script',
        label: `npm run ${runner.scriptName}`,
        command,
        args,
        fallbackPort: 3000,
        honorsPortEnv: true,
      }
    }
  }

  // No package.json (or no usable script). If we see static HTML, serve it.
  if (existsSync(join(projectPath, 'index.html'))) {
    return {
      kind: 'static-html',
      label: 'Static HTML',
      // The dev-server manager will substitute --port at runtime.
      command: 'npx',
      args: ['--yes', 'serve@latest', '--no-clipboard', '-l', '__PORT__', '.'],
      fallbackPort: 4173,
      honorsPortEnv: false,
    }
  }

  return {
    kind: 'unknown',
    label: 'Unknown project',
    command: '',
    args: [],
    fallbackPort: 0,
    honorsPortEnv: false,
  }
}
