import { X } from 'lucide-react'
import { useContacts, useExplain } from '../api/client'
import type { DownlinkContest, RelayContest, RunInfo } from '../api/types'
import { useConsole } from '../store'
import {
  CERTIFICATES, Card, Chip, Empty, Failure, IDLE_REASONS, Loading, Note, VERDICTS,
  action, num, reason, usd,
} from '../ui'
import { WindowProof } from './charts'

// The three layers are always shown in the same order — data, contest,
// satellite — and a layer that has nothing to say says so. Collapsing them
// into one sentence is exactly what the criterion asks us not to do.

const GROUP_CERTIFICATE = 'satellite_contacts_oversubscribed'

export function JobExplain({ run }: { run: RunInfo }) {
  const jobId = useConsole((s) => s.selectedJob)
  const selectJob = useConsole((s) => s.selectJob)
  const setCursor = useConsole((s) => s.setCursor)
  const { data, isPending, error } = useExplain(run.run_id, jobId)
  const { data: contacts } = useContacts(run.run_id)

  if (!jobId) {
    return (
      <Card title="Почему не вышло"
            note="Выберите задание в таблице или клетку на полотне — разбор соберётся из сертификатов, решения по связи, журнала модели и занятости аппаратов.">
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
  const contest = data.competition
  const isGroup = data.impossible?.certificate === GROUP_CERTIFICATE
  const contestOn = contest?.kind === 'downlink'
    ? !contest.selected && contest.slots_taken_total > 0
    : contest?.kind === 'relay' ? contest.busy_steps > 0 : false

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
              {isGroup ? (
                <p className="tbl-note">
                  Сертификат групповой: доказано, что заданиям этого аппарата в интервале не
                  хватает контактов, а не что невыполнимо именно это задание. Какое из них
                  выпадет, выбирает планировщик по цели управления — это показывает слой 2.
                </p>
              ) : (
                <p className="tbl-note">
                  Сертификат выдан против сценария, а не против нашего расписания: его можно
                  проверить, не запуская наш планировщик.
                </p>
              )}
            </>
          ) : (
            <p className="off">Данные выполнение не запрещают.</p>
          )}
        </li>

        <li className={contestOn ? 'on' : ''}>
          <h4>2 · {data.job.kind === 'downlink' ? 'Проиграло контакт' : 'Проиграло аппараты другим заданиям'}</h4>
          {!contest ? (
            <p className="off">Разбор конкуренции для этого задания не собрался.</p>
          ) : contest.kind === 'downlink' ? (
            <DownlinkLayer contest={contest} onStep={setCursor} />
          ) : (
            <RelayLayer contest={contest} />
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

/** Ground contact: past slots from the log, future ones from the schedule. */
function DownlinkLayer({ contest, onStep }: { contest: DownlinkContest; onStep: (step: number) => void }) {
  const counter = contest.counterfactual
  return (
    <>
      {contest.selected && <p className="off">Задание в расписании связи: контакт за ним закреплён.</p>}
      <p>
        Контактов в окне: <b>{contest.slots_in_window}</b> — отработано этим заданием{' '}
        <b>{contest.slots_worked}</b>, занято другими <b>{contest.slots_taken_total}</b>,
        свободных <b>{contest.slots_free}</b>
        {contest.slots_free_past > 0 && <>, из них уже в прошлом {contest.slots_free_past}</>}.
      </p>
      {!!contest.slots_taken.length && (
        <div className="scroll">
          <table>
            <thead><tr><th>Шаг</th><th>Слот занял</th><th className="num">Приоритет</th>
              <th className="num">Цена</th><th>Откуда</th></tr></thead>
            <tbody>
              {contest.slots_taken.slice(0, 10).map((row) => (
                <tr key={row.step} onClick={() => onStep(row.step)}>
                  <td className="num">{row.step}</td>
                  <td className="id">{row.taken_by}</td>
                  <td className="num">{row.priority}</td>
                  <td className="num">{usd(row.value_usd)}</td>
                  <td>{row.source === 'log' ? 'журнал' : 'расписание'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {contest.closed ? (
        <p className="tbl-note">
          Срок вышел: занятость контактов взята из журнала исполнения. Цену размена задним
          числом не пересчитать — расписание связи строится только вперёд.
        </p>
      ) : !contest.planned ? (
        <p className="tbl-note">
          Этот планировщик не держит расписание связи заранее: до курсора занятость взята из
          журнала, впереди курсора она ещё не решена.
        </p>
      ) : counter && (counter.servable ? (
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
  )
}

/** Relay: satellite time is the contested resource, and the log is the record. */
function RelayLayer({ contest }: { contest: RelayContest }) {
  const idle = contest.idle_in_contact
  const reasons = (Object.keys(idle) as (keyof typeof idle)[]).filter((key) => idle[key] > 0)
  return (
    <>
      <p>
        В исполненной части окна, шаги {contest.window_executed[0]}–{contest.window_executed[1]},
        допустимые аппараты были заняты другими заданиями <b>{num(contest.busy_steps)}</b>{' '}
        аппарато-шагов
        {contest.calibrate_steps > 0 && <>, калибровались <b>{num(contest.calibrate_steps)}</b></>}.
      </p>
      {!!contest.rivals.length && (
        <div className="scroll">
          <table>
            <thead><tr><th>Кто занимал</th><th className="num">Шагов</th>
              <th className="num">Приоритет</th><th className="num">Цена</th></tr></thead>
            <tbody>
              {contest.rivals.map((row) => (
                <tr key={row.job_id}>
                  <td className="id">{row.job_id}</td>
                  <td className="num">{row.steps}</td>
                  <td className="num">{row.priority ?? '—'}</td>
                  <td className="num">{usd(row.value_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {contest.rivals_total > contest.rivals.length && (
            <p className="tbl-note">Показаны {contest.rivals.length} из {contest.rivals_total} заданий.</p>
          )}
        </div>
      )}
      <p>
        Простаивали при открытой связи <b>{num(contest.idle_in_contact_total)}</b> аппарато-шагов
        {reasons.length > 0 && <>: {reasons.map((key) => `${IDLE_REASONS[key]} ${idle[key]}`).join(', ')}</>}.
        Без связи для ретрансляции: {num(contest.idle_no_contact)}.
      </p>
      {!contest.closed && (
        <p className="tbl-note">
          Окно ещё открыто: ретрансляция решается на каждом шаге и заранее не обещается.
        </p>
      )}
    </>
  )
}
