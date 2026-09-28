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
    <Card className="flex min-h-0 flex-col gap-3.5 p-4 wide:gap-3 wide:p-[18px]" padded={false}>
      <h2 className="font-display text-[20px] font-bold text-text wide:font-sans wide:text-[16px]">
        {`Ideeën${ideas?.length ? ` · ${ideas.length}` : ''}`}
      </h2>
      <form
        className="flex flex-col gap-2 wide:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Nieuw idee…"
          className="h-11 min-w-0 shrink-0 rounded-input bg-input px-3.5 wide:flex-1 text-[15px] font-medium text-text outline-none wide:h-[42px] wide:text-[14px]"
        />
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="h-11 rounded-input bg-input px-3 text-[15px] font-semibold text-text-dim outline-none wide:h-[42px] wide:text-[14px]"
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
        <div className="flex max-h-[320px] flex-col gap-3.5 overflow-y-auto wide:gap-2">
          {groups.map((group) => (
            <section key={group.id} className="flex flex-col">
              <h3 className="label-caps pb-1 wide:pb-0.5">{group.name}</h3>
              <ul className="flex flex-col">
                {group.list.map((idea) => (
                  <li
                    key={idea.id}
                    className="group flex items-center gap-2.5 border-t border-border py-[9px] wide:gap-3 wide:border-t-0 wide:py-1"
                  >
                    <span className="flex-1 text-[15px] leading-snug font-medium text-text wide:text-[14px] wide:font-normal">
                      {idea.text}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-[13px] font-bold text-accent-soft transition-opacity hover:opacity-80"
                      title="Er is iets mee gedaan"
                      onClick={() => void api.ideas.update(idea.id, { status: 'done' })}
                    >
                      gedaan
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-[13px] font-bold text-text-faint transition-colors hover:text-text-dim"
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
