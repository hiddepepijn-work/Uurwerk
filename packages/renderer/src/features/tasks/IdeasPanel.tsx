import { useMemo, useState } from 'react'

import type { Idea, Project } from '@core/contract/types.js'

import { api } from '../../api/client.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { Card } from '../../ui/Card.js'

/**
 * The ideas pot: what Hidde says to Jarvis as "voeg dit idee toe", grouped by project. Not
 * tasks: nothing here is planned. An idea is done when it became something, or let go.
 */
export function IdeasPanel({ projects }: { projects: Project[] }) {
  const { data: ideas } = useLiveQuery((client) => client.ideas.list(), ['tasks'], [])
  const [text, setText] = useState('')
  const [projectId, setProjectId] = useState('')

  const groups = useMemo(() => {
    const byProject = new Map<string, Idea[]>()
    for (const idea of ideas ?? []) {
      const key = idea.projectId ?? ''
      byProject.set(key, [...(byProject.get(key) ?? []), idea])
    }
    const name = (id: string): string => projects.find((project) => project.id === id)?.name ?? 'Zonder project'
    return [...byProject.entries()].map(([id, list]) => ({ id, name: id ? name(id) : 'Zonder project', list })).sort((a, b) => a.name.localeCompare(b.name))
  }, [ideas, projects])

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    const project = projects.find((entry) => entry.id === projectId)
    await api.ideas.add({ text, projectId: project?.id ?? null, areaId: project?.areaId ?? null })
    setText('')
  }

  return (
    <Card title={`Ideeën${ideas?.length ? ` · ${ideas.length}` : ''}`} className="flex min-h-0 flex-col">
      <form
        className="mb-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Nieuw idee…"
          className="min-w-0 flex-1 rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
        />
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="rounded-[8px] border border-border bg-bg px-2 py-2 text-[13px] text-text outline-none focus:border-accent"
        >
          <option value="">Zonder project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </form>

      {groups.length === 0 ? (
        <p className="text-[13px] text-text-dim">Nog geen ideeën. Zeg tegen Jarvis: "voeg dit idee toe voor …".</p>
      ) : (
        <div className="flex max-h-[320px] flex-col gap-4 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.id}>
              <h3 className="mb-1.5 text-[12px] font-semibold tracking-wide text-text-dim uppercase">{group.name}</h3>
              <ul className="flex flex-col gap-1">
                {group.list.map((idea) => (
                  <li key={idea.id} className="group flex items-start gap-2 rounded-[8px] px-2 py-1.5 hover:bg-bg">
                    <span className="flex-1 text-[14px] leading-snug text-text">{idea.text}</span>
                    <button
                      type="button"
                      className="shrink-0 text-[12px] text-text-dim hover:text-accent"
                      title="Er is iets mee gedaan"
                      onClick={() => void api.ideas.update(idea.id, { status: 'done' })}
                    >
                      gedaan
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-[12px] text-text-dim hover:text-text"
                      title="Laten gaan"
                      onClick={() => void api.ideas.update(idea.id, { status: 'dropped' })}
                    >
                      weg
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  )
}
