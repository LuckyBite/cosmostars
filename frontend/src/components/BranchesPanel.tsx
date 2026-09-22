import { useMemo, useState } from 'react'
import {
  Background, Controls, ReactFlow, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, useCompare, useRunMutation, useRuns } from '../api/client'
import type { RunInfo } from '../api/types'
import { useConsole } from '../store'
import { Card, Chip, Failure, Loading, Note, num, signed, usd } from '../ui'

// The tree is laid out in the shift's own time: a node sits at the step it was
// branched from, so a fork is visibly a fork in the shift, not an arrow in a
// diagram. Comparison then asks the service whether the pair is even readable
// — same scenario, same steps, same messages in the same order — and shows that
// answer before it shows any numbers.

const LANE = 176
const SPAN = 720

interface RunNodeData extends Record<string, unknown> {
  run: RunInfo
  active: boolean
  side: 'left' | 'right' | null
  onOpen: () => void
  onPick: (side: 'left' | 'right') => void
}

function RunNode({ data }: NodeProps<Node<RunNodeData>>) {
  const { run, active, side, onOpen, onPick } = data
  return (
    <div className={'run-node' + (active ? ' active' : '')}>
      <header>
        <b>{run.title}</b>
        <span className="mono">{run.run_id.slice(0, 6)}</span>
      </header>
      <div className="run-node-body">
        <Chip>{run.goal === 'priority' ? 'приоритет' : 'выручка'}</Chip>
        <Chip>{run.planner}</Chip>
        <Chip>{run.step} / {run.total_steps}</Chip>
        {!!run.events_received && <Chip tone="ser">Сообщений {run.events_received}</Chip>}
      </div>
      <dl className="dl">
        <dt>П3 в срок</dt>
        <dd>{run.summary.critical_jobs_completed_on_time} / {run.summary.critical_jobs_due}</dd>
        <dt>Выручка</dt><dd>{usd(run.summary.revenue_usd)}</dd>
        <dt>Просрочено</dt><dd>{num(run.summary.jobs_due_missed)}</dd>
      </dl>
      <div className="run-node-acts">
        <button className="btn slim" onClick={onOpen}>Открыть</button>
        <button className="pill" aria-pressed={side === 'left'} onClick={() => onPick('left')}>A</button>
        <button className="pill" aria-pressed={side === 'right'} onClick={() => onPick('right')}>Б</button>
      </div>
    </div>
  )
}

const nodeTypes = { run: RunNode }

export function BranchesPanel({ run }: { run: RunInfo }) {
  const runs = useRuns()
  const openRun = useConsole((s) => s.openRun)
  const left = useConsole((s) => s.compareLeft)
  const right = useConsole((s) => s.compareRight)
  const setCompare = useConsole((s) => s.setCompare)
  const fork = useRunMutation(() => api.fork(run.run_id), run.run_id)
  const report = useCompare(left, right)
  const [showAll, setShowAll] = useState(false)

  const { nodes, edges } = useMemo(() => {
    const all = runs.data?.items ?? []
    const byId = new Map(all.map((item) => [item.run_id, item]))
    const rootOf = (runId: string) => {
      let current = byId.get(runId)
      const seen = new Set<string>()
      while (current?.parent_id && byId.has(current.parent_id) && !seen.has(current.run_id)) {
        seen.add(current.run_id)
        current = byId.get(current.parent_id)
      }
      return current?.run_id ?? runId
    }
    // By default the tree shows this shift and its branches: that is the only
    // set where "continuations start from the same state" is even a claim. Two
    // independent runs picked for comparison are kept too, because comparing
    // them is legitimate — the report just has to say they share no origin.
    const home = rootOf(run.run_id)
    const items = all.filter((item) =>
      showAll || rootOf(item.run_id) === home ||
      item.run_id === left || item.run_id === right)

    const scale = (step: number, total: number) => (total ? (step / total) * SPAN : 0)
    const lanes = new Map<string, number>()
    let lane = 0
    const ordered = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at))
    for (const item of ordered) {
      lanes.set(item.run_id, lane++)
    }
    const nodes: Node<RunNodeData>[] = ordered.map((item) => ({
      id: item.run_id,
      type: 'run',
      position: {
        x: scale(item.forked_at_step ?? 0, item.total_steps),
        y: (lanes.get(item.run_id) ?? 0) * LANE,
      },
      data: {
        run: item,
        active: item.run_id === run.run_id,
        side: left === item.run_id ? 'left' : right === item.run_id ? 'right' : null,
        onOpen: () => openRun(item.run_id),
        onPick: (side: 'left' | 'right') => setCompare(side, item.run_id),
      },
      draggable: true,
    }))
    const shown = new Set(ordered.map((item) => item.run_id))
    const edges: Edge[] = ordered
      .filter((item) => item.parent_id && shown.has(item.parent_id))
      .map((item) => ({
        id: `${item.parent_id}-${item.run_id}`,
        source: item.parent_id as string,
        target: item.run_id,
        label: `шаг ${item.forked_at_step}`,
        animated: false,
        style: { stroke: 'var(--axis)' },
        labelStyle: { fill: 'var(--ink-3)', fontSize: 11 },
      }))
    return { nodes, edges }
  }, [runs.data, run.run_id, left, right, openRun, setCompare, showAll])

  return (
    <>
      <Failure error={runs.error ?? fork.error} what="Дерево смен не построилось" />
      <Card title="Дерево смены"
            note="Узел — точка, в которой оператор остановился и продолжил иначе. Ветвь наследует состояние целиком: заряд, температуру, калибровку и прогресс заданий, — и дальше живёт отдельно. Свежая ветвь повторяет родителя: разница появится, когда вы измените в ней цель, вбросите сообщение или досчитаете её иначе."
            right={<div className="acts">
              <button className="pill" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                все запуски
              </button>
              <button className="btn" onClick={() => fork.mutate(undefined, {
                onSuccess: (branch) => {
                  const made = branch as RunInfo
                  setCompare('left', run.run_id)
                  setCompare('right', made.run_id)
                  openRun(made.run_id)
                },
              })}>Ветвь отсюда</button>
            </div>}>
        {runs.isPending ? <Loading what="Смены" /> : (
          <div className="tree-flow">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
                       fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.25 }}
                       proOptions={{ hideAttribution: true }}
                       nodesConnectable={false} edgesFocusable={false}>
              <Background gap={24} color="var(--grid)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )}
        <p className="tbl-note">
          По горизонтали — шаг, на котором ветвь отделилась от родителя. Кнопки «A» и «Б»
          выбирают пару для сравнения.
        </p>
      </Card>

      <Card title="Сравнение вариантов"
            note="Сначала проверка сопоставимости, потом числа: сравнивать ветви с разными сообщениями или разным числом шагов — значит получить красивую, но ложную разницу.">
        {!left || !right || left === right ? (
          <Note><span>{!left && !right
            ? 'Выберите на дереве два узла: кнопка «A» на одном, «Б» на другом.'
            : left && left === right
              ? '«A» и «Б» указывают на одну и ту же смену — выберите вторую.'
              : 'Выбран один узел. Отметьте второй кнопкой «' + (left ? 'Б' : 'A') + '».'}</span></Note>
        ) : report.isPending ? <Loading what="Сравнение" />
          : report.error ? <Failure error={report.error} what="Сравнение не выполнено" />
          : report.data && (
          <>
            <div className={'verdict' + (report.data.comparability.comparable ? ' ok' : '')}>
              {report.data.comparability.comparable ? (
                <>
                  <b>Ветви сопоставимы.</b>{' '}
                  {report.data.comparability.shared_origin && (
                    <>Общее контрольное состояние: ветвление на шаге{' '}
                      {report.data.comparability.shared_origin.branch_step ?? '—'}. </>
                  )}
                  {report.data.verdict.text}.
                </>
              ) : (
                <>
                  <b>Сравнивать нельзя.</b> {report.data.comparability.warnings.join('; ')}.
                  Числа ниже показаны, но вывод из них делать некорректно.
                </>
              )}
            </div>

            {report.data.metrics.every((row) => row.delta === 0) && (
              <Note>
                <span>Все показатели совпали до единицы. Это не сбой сравнения: ветвь
                  повторяет родителя, пока в ней ничего не изменено. Переключите в одной из
                  них цель управления, вбросьте сообщение или досчитайте её до другого шага —
                  и разница появится здесь же.</span>
              </Note>
            )}

            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Показатель</th>
                    <th className="num">A · {report.data.left.title}</th>
                    <th className="num">Б · {report.data.right.title}</th>
                    <th className="num">Разница</th>
                    <th>Лучше</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.metrics.map((row) => (
                    <tr key={row.metric}>
                      <td>{row.label}</td>
                      <td className="num">{format(row.metric, row.left)}</td>
                      <td className="num">{format(row.metric, row.right)}</td>
                      <td className={'num ' + (row.leader === null ? 'flat'
                        : row.leader === report.data!.left.run_id ? 'up' : 'down')}>
                        {row.better === 'нейтрально' ? '—' : signed(row.delta, 2)}
                      </td>
                      <td>
                        {row.better === 'нейтрально' ? <Chip>Не сравнивается</Chip>
                          : row.leader === null ? <Chip>Поровну</Chip>
                          : <Chip tone="good">{row.leader === report.data!.left.run_id ? 'A' : 'Б'}</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tbl-note">
              Цель сравнения — <b>{report.data.goal === 'priority' ? 'приоритет' : 'выручка'}</b>.
              Равные результаты называются равными: на сценариях без дефицита обе цели дают одно
              и то же расписание, и это тоже ответ.
            </p>
          </>
        )}
      </Card>
    </>
  )
}

const format = (metric: string, value: number) =>
  metric === 'revenue_usd' ? usd(value)
    : metric === 'minimum_soc_pct' ? value.toFixed(1) + '%'
    : num(value)
