import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CheckCircle2, FileUp, RefreshCw, XCircle } from 'lucide-react'
import { ApiError, api, useAudit } from '../api/client'
import type { RunInfo, VerifyReport } from '../api/types'
import { Card, Chip, Failure, Loading, Note, num, usd } from '../ui'

// Reproducibility, answered in the browser.
//
// The check is run by the shipped library's own `replay_episode`, not by our
// planner: the export is recomputed from the scenario, the messages and the
// commands, and the result is compared field by field against what the file
// claims. A passing report therefore says nothing about trusting our code.

export function VerifyPanel({ run }: { run: RunInfo }) {
  const [report, setReport] = useState<VerifyReport | null>(null)
  const [source, setSource] = useState<string>('')

  const check = useMutation<VerifyReport, ApiError, void>({
    mutationFn: () => api.verifyRun(run.run_id),
    onSuccess: (data) => { setReport(data); setSource(`текущая смена ${run.run_id.slice(0, 6)}`) },
  })

  const upload = useMutation<VerifyReport, ApiError, File>({
    mutationFn: async (file) => api.verifyExport(JSON.parse(await file.text())),
    onSuccess: (data, file) => { setReport(data); setSource(file.name) },
  })

  return (
    <>
      <Card title="Проверка расчёта"
            note="Выгрузка прогоняется через replay_episode выданной библиотеки и сверяется с собой: хеш исходного сценария, сводка и журнал построчно.">
        <div className="acts">
          <button className="btn primary" disabled={check.isPending} onClick={() => check.mutate()}>
            <RefreshCw size={14} aria-hidden /> проверить текущую смену
          </button>
          <label className="btn">
            <FileUp size={14} aria-hidden /> проверить файл выгрузки
            <input type="file" accept="application/json" hidden
                   onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </label>
        </div>
        <Failure error={check.error ?? upload.error} what="Проверка не прошла" />

        <Note>
          <span>
            То же самое руками, без нашего кода:{' '}
            <code>python model/operations.py --result result.json --output replay.json</code>
          </span>
        </Note>

        {report && (
          <div className="verify">
            <div className={'verdict' + (report.verdict === 'reproduced' ? ' ok' : '')}>
              {report.verdict === 'reproduced'
                ? <CheckCircle2 size={16} aria-hidden />
                : <XCircle size={16} aria-hidden />}
              <span>
                <b>{report.verdict === 'reproduced' ? 'Расчёт воспроизведён.' : 'Расхождение.'}</b>{' '}
                Источник: {source}. Проверено через <code>{report.checked_by}</code>.
              </span>
            </div>

            <table>
              <thead>
                <tr><th>Что сверялось</th><th>Результат</th><th>Подробности</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Хеш исходного сценария</td>
                  <td><Verdict ok={report.scenario.match} /></td>
                  <td className="id">{report.scenario.hash_recomputed.slice(0, 16)}…</td>
                </tr>
                <tr>
                  <td>Выполнено шагов</td>
                  <td><Verdict ok={report.replay.match} /></td>
                  <td>
                    {report.replay.steps_executed_replayed} из {report.replay.steps_executed_in_file},
                    сообщений {report.replay.events_replayed}, команд {num(report.replay.commands_replayed)}
                  </td>
                </tr>
                <tr>
                  <td>Сводные показатели</td>
                  <td><Verdict ok={report.summary.match} /></td>
                  <td>
                    сверено полей: {report.summary.fields_compared}
                    {!!report.summary.mismatches.length && (
                      <> · расходятся: {report.summary.mismatches.map((item) => item.field).join(', ')}</>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Журнал модели</td>
                  <td><Verdict ok={report.trace.match} /></td>
                  <td>
                    {num(report.trace.rows_replayed)} строк,
                    {' '}хеш {report.trace.digest_replayed.slice(0, 12)}…
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="tiles">
              <Tileish label="Выполнено заданий" value={num(report.summary.replayed.jobs_completed)} />
              <Tileish label="П3 в срок"
                       value={`${report.summary.replayed.critical_jobs_completed_on_time} / ${report.summary.replayed.critical_jobs_due}`} />
              <Tileish label="Выручка" value={usd(report.summary.replayed.revenue_usd)} />
              <Tileish label="Отклонённых команд" value={num(report.summary.replayed.blocked_command_count)} />
            </div>

            <p className="tbl-note">
              Сравнение чисел ведётся с допуском {report.tolerance} — это запас на представление
              дробей в JSON, а не на разницу в расчёте. Журнал сверяется построчно по хешу.
            </p>
          </div>
        )}
      </Card>

      <AuditCard run={run} />

      <Card title="Что лежит в выгрузке"
            note="Формат кейса cosmo-B-ops-result-1.0: исходный сценарий целиком, полученные сообщения в порядке получения, все команды по шагам, число выполненных шагов, сводка и метаданные запуска.">
        <dl className="dl">
          <dt>Схема</dt><dd>cosmo-B-ops-result-1.0</dd>
          <dt>Смена</dt><dd>{run.scenario_key}</dd>
          <dt>Планировщик</dt><dd>{run.planner} {run.planner_version}</dd>
          <dt>Цель</dt><dd>{run.goal}{run.goal_switches.length > 0 && ` · переключений: ${run.goal_switches.length}`}</dd>
          <dt>Сообщений принято</dt><dd>{run.events_received}</dd>
          <dt>Происхождение ветви</dt>
          <dd>{run.parent_id ? `${run.parent_id.slice(0, 6)} с шага ${run.forked_at_step}` : 'исходный запуск'}</dd>
        </dl>
        <p className="tbl-note">
          Кнопка «выгрузка» в шапке сохраняет этот файл. Он же принимается формой выше и
          командой воспроизведения — это один и тот же файл.
        </p>
      </Card>
    </>
  )
}

// Воспроизводимость выше отвечает на вопрос «повторяется ли расчёт» — и
// отвечает силами той же библиотеки. Здесь другое: журнал пересчитан по
// описанию модели нашим собственным кодом, который библиотеку не вызывает.
// Совпадение двух независимых реализаций — это уже не доверие к одной из них.
function AuditCard({ run }: { run: RunInfo }) {
  const { data, isPending, error } = useAudit(run.run_id)
  return (
    <Card title="Независимый пересчёт журнала"
          note="Заряд, температура, обогрев, нагрузка, прогресс по заданиям, завершение и выручка пересчитаны по описанию модели, без обращения к выданной библиотеке, и сверены со журналом построчно.">
      <Failure error={error} what="Пересчёт не выполнен" />
      {isPending || !data ? <Loading what="Пересчёт" /> : run.step === 0 ? (
        <Note><span>Смена ещё не сделала ни шага — пересчитывать нечего.</span></Note>
      ) : (
        <>
          <div className={'verdict' + (data.verdict === 'consistent' ? ' ok' : '')}>
            {data.verdict === 'consistent'
              ? <CheckCircle2 size={16} aria-hidden />
              : <XCircle size={16} aria-hidden />}
            <span>
              <b>{data.verdict === 'consistent'
                ? 'Учёт сходится с независимым пересчётом.'
                : 'Найдено расхождение.'}</b>{' '}
              Проверено {num(data.physics.rows_checked)} строк журнала на шаге {data.at_step}.
            </span>
          </div>
          <table>
            <thead><tr><th>Что пересчитано</th><th>Результат</th><th>Подробности</th></tr></thead>
            <tbody>
              <tr>
                <td>Энергия, температура, обогрев, нагрузка</td>
                <td><Verdict ok={data.physics.match} /></td>
                <td>{num(data.physics.rows_checked)} строк, расхождений {num(data.physics.mismatch_count)}</td>
              </tr>
              <tr>
                <td>Прогресс, завершение, выручка, лимиты</td>
                <td><Verdict ok={data.accounting.match} /></td>
                <td>
                  выручка {usd(data.accounting.recomputed.revenue_usd)},
                  завершено {num(data.accounting.recomputed.jobs_completed)},
                  отклонено команд {num(data.accounting.recomputed.blocked_command_count)}
                </td>
              </tr>
            </tbody>
          </table>
          {!!data.physics.mismatches.length && (
            <p className="tbl-note">
              Первое расхождение: шаг {data.physics.mismatches[0].step},{' '}
              {data.physics.mismatches[0].satellite_id}, поле{' '}
              {data.physics.mismatches[0].field} — пересчитано{' '}
              {data.physics.mismatches[0].recomputed}, в журнале{' '}
              {data.physics.mismatches[0].in_log}.
            </p>
          )}
          <p className="tbl-note">{data.what_it_proves}</p>
        </>
      )}
    </Card>
  )
}

const Verdict = ({ ok }: { ok: boolean }) =>
  ok ? <Chip tone="good">сошлось</Chip> : <Chip tone="crit">разошлось</Chip>

const Tileish = ({ label, value }: { label: string; value: string }) => (
  <div className="tile"><span className="k">{label}</span><span className="v">{value}</span></div>
)
