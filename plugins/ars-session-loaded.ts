import { Plugin } from "@opencode/plugin"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"

/**
 * ars-session-loaded
 *
 * OpenCode V2 plugin for the Academic Research Skills suite.
 *
 * Hooks:
 *   event (session.created)         — logs a startup notice and records ARS state
 *                                     as a session instruction entry
 *   tool execute.before             — write-scope guard: enforces per-agent write
 *                                     boundaries from ars_phase_scope_manifest.json
 *   shell create.before             — injects ARS env vars into shell executions
 *
 * The write guard is ADVISORY by default — it logs violations but does not
 * block writes. Set ARS_WRITE_GUARD=strict to throw and block out-of-scope writes.
 */

// --- Types ---

interface AgentEntry {
  bucket: string
  skill: string
  phase: string
  allowed_write_globs: string[]
}

interface PhaseManifest {
  version: number
  agents: Record<string, AgentEntry>
}

// --- Helpers ---

/**
 * Load the phase scope manifest from the repo.
 * Searches relative to plugin location and cwd.
 */
function loadManifest(pluginDir: string, workDir: string): PhaseManifest | null {
  const candidates = [
    resolve(pluginDir, "..", "scripts", "ars_phase_scope_manifest.json"),
    resolve(workDir, "scripts", "ars_phase_scope_manifest.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Match a file path against a glob pattern.
 * Supports: "phase1_*\/**", "phase7_*\/paper.md", "**\/*.yaml"
 */
function matchGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "")
  const regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*")
  return new RegExp(`^${regexStr}$`).test(normalized)
}

/**
 * Count unique *_agent.md files in a directory tree.
 */
function countAgents(workDir: string): number {
  try {
    const { execSync } = require("node:child_process")
    const output = execSync(
      `find "${workDir}/skills" -name "*_agent.md" -not -path "*/.git/*" 2>/dev/null | wc -l`,
      { encoding: "utf-8" },
    )
    return parseInt(output.trim(), 10) || 0
  } catch {
    return 38 // fallback to known count
  }
}

/**
 * Count *_agent.md files within a single skill directory.
 */
function countSkillAgents(workDir: string, skill: string): number {
  try {
    const { execSync } = require("node:child_process")
    const output = execSync(
      `find "${workDir}/skills/${skill}" -name "*_agent.md" -not -path "*/.git/*" 2>/dev/null | wc -l`,
      { encoding: "utf-8" },
    )
    return parseInt(output.trim(), 10) || 0
  } catch {
    return 0
  }
}

// --- Plugin ---

export default Plugin.define({
  id: "ars-session-loaded",
  async setup(ctx) {
    const pluginDir = dirname(new URL(import.meta.url).pathname)
    const workDir = ctx.location.project.canonical
    const manifest = loadManifest(pluginDir, workDir)
    const isStrict = process.env.ARS_WRITE_GUARD === "strict"
    const agentCount = countAgents(workDir)

    // Build the startup message
    const guardStatus = manifest
      ? `active${isStrict ? " [STRICT — will block out-of-scope writes]" : " [advisory]"}`
      : "manifest not found (guard disabled)"

    const startupMessage = [
      `Academic Research Skills (ARS) v3.13.0 loaded.`,
      ``,
      `Skills:`,
      `  deep-research            ${countSkillAgents(workDir, "deep-research")} agents, 8 modes`,
      `  academic-paper           ${countSkillAgents(workDir, "academic-paper")} agents, 11 modes`,
      `  academic-paper-reviewer   ${countSkillAgents(workDir, "academic-paper-reviewer")} agents, 6 modes`,
      `  academic-pipeline        10-stage orchestrator`,
      ``,
      `Commands: 16 (/ars-plan, /ars-full, /ars-lit-review, /ars-reviewer, ...)`,
      `Agents: ${agentCount} unique *_agent.md files`,
      `Write-scope guard: ${guardStatus}`,
    ].join("\n")

    const pipelineState = `## ARS Pipeline State (preserved across compaction)

This session uses the Academic Research Skills (ARS) v3.13.0 suite.

Key context to preserve:
- Active skill and mode (check the most recent /ars-* command invocation)
- Current pipeline phase (if running /ars-full, note which stage: research/write/review/revise/finalize)
- Material Passport path and any human-read acknowledgments
- Citation keys that failed verification (need re-check or /ars-cache-invalidate)
- Write-scope guard mode: ${isStrict ? "STRICT (blocks out-of-scope writes)" : "advisory (logs only)"}
- Any cross-model verification results or integrity gate outcomes

Available commands: /ars-plan, /ars-full, /ars-lit-review, /ars-reviewer,
/ars-revision, /ars-revision-coach, /ars-abstract, /ars-outline,
/ars-citation-check, /ars-format-convert, /ars-disclosure,
/ars-mark-read, /ars-unmark-read, /ars-cache-invalidate, /ars-3w, /ars-rebuttal-audit

Routing: if the user's intent spans multiple pipeline phases, clarify before routing.
Do NOT auto-route ambiguous cross-phase materials to a single-phase agent.`

    const controller = new AbortController()

    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal })) {
        console.info(startupMessage)
        await ctx.session.instructions.entry
          .put({ sessionID: event.data.sessionID, key: "ars-pipeline-state", value: pipelineState })
          .catch(() => {})
      }
    })().catch(() => {})

    // --- Write-scope guard: enforce phase boundaries on file writes ---
    await ctx.tool.hook("execute.before", (event) => {
      if (!manifest) return

      // Only guard write-capable tools
      const writeTools = ["write", "edit", "multiedit", "apply_patch"]
      const toolName = (event.tool ?? "").toLowerCase()
      if (!writeTools.includes(toolName)) return

      // Extract the target file path from tool args
      const args = event.input as Record<string, unknown> | undefined
      const filePath =
        (args?.filePath as string) ??
        (args?.file_path as string) ??
        (args?.path as string) ??
        ""
      if (!filePath) return

      // Normalize to workspace-relative path
      const relative = filePath.startsWith(workDir)
        ? filePath.slice(workDir.length + 1)
        : filePath.replace(/^\.\//, "")

      // Only guard writes to phase directories (phase1_*, phase2_*, etc.)
      // Infrastructure files (scripts/, docs/, etc.) are always allowed.
      if (!/^phase\d/.test(relative)) return

      // Check if the path matches ANY agent's allowed write globs.
      // Since OpenCode's tool execute hook doesn't expose the active
      // subagent identity, we enforce the weaker invariant: all phase-dir
      // writes must land in SOME agent's allowed scope.
      const inScope = Object.values(manifest.agents).some((entry) =>
        entry.allowed_write_globs.some((glob) => matchGlob(relative, glob)),
      )

      if (!inScope) {
        const msg =
          `[ARS write-guard] write to "${relative}" is outside all ` +
          `agents' allowed_write_globs in ars_phase_scope_manifest.json`

        if (isStrict) {
          // In strict mode, throw to BLOCK the write
          console.error(`[ars-write-guard] BLOCKED: ${msg}`)
          throw new Error(msg)
        }

        // Advisory mode: log warning but allow the write
        console.warn(`[ars-write-guard] WARNING: ${msg}`)
      }
    })

    // --- Shell env: inject ARS environment variables ---
    await ctx.shell.hook("create.before", (event) => {
      // Ensure ARS Python scripts can find the manifest and cache
      if (!event.env.ARS_MANIFEST_PATH && manifest) {
        const manifestPath = resolve(workDir, "scripts", "ars_phase_scope_manifest.json")
        if (existsSync(manifestPath)) {
          event.env.ARS_MANIFEST_PATH = manifestPath
        }
      }
      // Propagate strict guard mode to child processes
      if (isStrict && !event.env.ARS_WRITE_GUARD) {
        event.env.ARS_WRITE_GUARD = "strict"
      }
    })

    return () => controller.abort()
  },
})
