import { X } from 'lucide-react'
import { useContacts, useExplain } from '../api/client'
import type { RunInfo } from '../api/types'
import { useConsole } from '../store'
import {
  CERTIFICATES, Card, Chip, Empty, Failure, Loading, Note, VERDICTS, action, num, reason, usd,
} from '../ui'
import { WindowProof } from './charts'

// The three layers are always shown in the same order — data, contest,
// satellite — and a layer that has nothing to say says so. Collapsing them
// into one sentence is exactly what the criterion asks us not to do.

export function JobExplain({ run }: { run: RunInfo }) {
  const jobId = useConsole((s) => s.selectedJob)
  const selectJob = useConsole((s) => s.selectJob)
  const setCursor = useConsole((s) => s.setCursor)
  const { data, isPending, error } = useExplain(run.run_id, jobId)
  const { data: contacts } = useContacts(run.run_id)

  if (!jobId) {
    return (
      <Card title="Почему не вышло"
            note="Выберите задание в таблице или клетку на полотне — разбор соберётся из сертификатов, решения по связи и журнала модели.">
        <Empty>Задание не выбрано.</Empty>
      </Card>
    )
  }
  if (isPending || !data) {
    return <Card title={`Разбор ${jobId}`}><Loading what="Разбор" /></Card>
  }

  const verdict = VERDICTS[data.verdict]
  const sat = data.job.eligible_satellites[0]
  const windows = contacts?.items.find((item) => item.satellite_id === sat)
  const counter = data.competition?.counterfactual

  return (
    <Card
      className="explain"
      title={<>Разбор {data.job_id} <Chip tone={verdict.tone || undefined}>{verdict.label}</Chip></>}
      note={<>
        {data.job.kind === 'downlink' ? 'наземная связь' : 'ретрансляция'} · приоритет {data.job.priority} ·
        {' '}{usd(data.job.value_usd)} · окно {data.job.window[0]}–{data.job.window[1]} ·
        {' '}работы {data.job.work_steps} шагов, выполнено {data.job.progress_steps}
      </>}
      right={<button className="btn icon" aria-label="Закрыть разбор" onClick={() => selectJob(null)}>
        <X size={14} />
      </button>}
    >
      <Failure error={error} what="Разбор не собрался" />

      <ol className="layers">
        <li className={data.impossible ? 'on' : ''}>
          <h4>1 · Невозможно по данным</h4>
          {data.impossible ? (
            <>
              <p>
                {CERTIFICATES[data.impossible.certificate] ?? data.impossible.certificate}.
                {data.impossible.basis === 'whole_job' && ' Оценка задним числом: по всему заданию.'}
              </p>
              {data.impossible.window && windows && (
                <WindowProof window={data.impossible.window} contacts={windows.downlink}
                            need={data.impossible.work_required ?? data.job.work_steps}
                            have={data.impossible.contacts_in_window ?? 0}
                            total={run.total_steps} completedAt={data.job.completed_step} />
              )}
              {data.impossible.interval && (
                <p className="mono">
                  интервал {data.impossible.interval[0]}–{data.impossible.interval[1]} ·
                  заданий {data.impossible.jobs?.length} · нужно {data.impossible.work_required} ·
                  контактов {data.impossible.contacts_in_interval} ·
                  дефицит {data.impossible.shortfall}
                </p>
              )}
              <p className="tbl-note">
                Сертификат выдан против сценария, а не против нашего расписания: его можно
                проверить, не запуская наш планировщик.
              </p>
            </>
          ) : (
            <p className="off">Данные выполнение не запрещают.</p>
          )}
        </li>

        <li className={data.competition && !data.competition.selected ? 'on' : ''}>
          <h4>2 · Проиграло контакт</h4>
          {!data.competition ? (
            <p className="off">
              {data.job.kind === 'relay'
                ? 'Ретрансляция не планируется заранее: контакт доступен почти всегда, решение принимается на шаге.'
                : 'Расписание связи для этой смены не строилось.'}
            </p>
          ) : data.competition.selected ? (
            <p className="off">Задание в расписании связи: контакт за ним закреплён.</p>
          ) : (
            <>
              <p>
                Контактов в окне: <b>{data.competition.slots_in_window}</b>, из них свободных{' '}
                <b>{data.competition.slots_free}</b>, занятых другими заданиями{' '}
                <b>{data.competition.slots_taken_total}</b>.
              </p>
              {!!data.competition.slots_taken.length && (
                <div className="scroll">
                  <table>
                    <thead><tr><th>Шаг</th><th>Слот занял</th><th className="num">Приоритет</th>
                      <th className="num">Цена</th></tr></thead>
                    <tbody>
                      {data.competition.slots_taken.slice(0, 10).map((row) => (
                        <tr key={row.step} onClick={() => setCursor(row.step)}>
                          <td className="num">{row.step}</td>
                          <td className="id">{row.taken_by}</td>
                          <td className="num">{row.priority}</td>
                          <td className="num">{usd(row.value_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {counter && (counter.servable ? (
                <Note>
                  <span>
                    <b>Цена размена.</b> Расписание пересчитано с этим заданием, поставленным
                    первым: оно выполнимо, но из плана выпадает{' '}
                    <b>{num(counter.jobs_dropped_count)}</b> заданий на{' '}
                    <b>{usd(counter.value_given_up_usd)}</b>
                    {!!counter.critical_given_up && <>, включая {counter.critical_given_up} приоритета 3</>}.
                    Взамен получаем {usd(counter.value_gained_usd)}
                    {counter.critical_gained ? ' и одно обязательство приоритета 3' : ''}.
                    {' '}{(counter.value_given_up_usd ?? 0) > (counter.value_gained_usd ?? 0)
                      ? 'Размен не в пользу смены.'
                      : 'Размен был бы в пользу смены — это граница нашего порядка отбора.'}
                  </span>
                </Note>
              ) : (
                <Note><span>
                  <b>Цена размена.</b> Даже поставленное первым, задание не получает набора
                  контактов: дело не в конкуренции, а в самих окнах.
                </span></Note>
              ))}
            </>
          )}
        </li>

        <li className={data.refusals.total ? 'on' : ''}>
          <h4>3 · Не пустил аппарат</h4>
          {data.refusals.total === 0 ? (
            <p className="off">Команд по этому заданию модель не отклоняла.</p>
          ) : (
            <>
              <p>
                Отклонено команд: <b>{num(data.refusals.total)}</b>, чаще всего —{' '}
                <Chip tone="crit">{reason(data.refusals.dominant_reason)}</Chip>
              </p>
              <div className="scroll">
                <table>
                  <thead><tr><th>Шаг</th><th>Аппарат</th><th>Причина</th></tr></thead>
                  <tbody>
                    {data.refusals.rows.slice(0, 10).map((row, i) => (
                      <tr key={i} onClick={() => setCursor(row.step)}>
                        <td className="num">{row.step}</td>
                        <td className="id">{row.satellite_id}</td>
                        <td>{reason(row.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </li>
      </ol>

      <div className="instead">
        <h4>Чем были заняты допустимые аппараты в окне задания</h4>
        <div className="readout">
          {Object.entries(data.instead.satellite_steps_by_action).map(([code, count]) => (
            <span key={code}>{action(code)} <b>{num(count)}</b></span>
          ))}
          {!Object.keys(data.instead.satellite_steps_by_action).length && <span>окно ещё не наступило</span>}
        </div>
        {data.instead.idle_while_in_contact_total > 0 && (
          <p className="tbl-note">
            Простой при открытом контакте: <b>{num(data.instead.idle_while_in_contact_total)}</b>{' '}
            аппарато-шагов. Первые из них:{' '}
            {data.instead.idle_while_in_contact.slice(0, 6).map((row) => (
              <button key={`${row.step}-${row.satellite_id}`} className="pill"
                      onClick={() => setCursor(row.step)}>
                {row.satellite_id}@{row.step} · {reason(row.reason)}
              </button>
            ))}
          </p>
        )}
      </div>

      {!!data.progress.total && (
        <p className="tbl-note">
          Работа по заданию шла на шагах:{' '}
          {data.progress.rows.slice(0, 12).map((row) => (
            <button key={`${row.step}-${row.satellite_id}`} className="pill"
                    onClick={() => setCursor(row.step)}>{row.satellite_id}@{row.step}</button>
          ))}
          {data.progress.total > 12 && <> и ещё {data.progress.total - 12}</>}
        </p>
      )}
    </Card>
  )
}
