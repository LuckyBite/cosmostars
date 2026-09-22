import { useMemo, type ReactNode } from 'react'
import { useContacts, useFeasibility, useGrid, useSlotPrices } from '../api/client'
import type { RunInfo } from '../api/types'
import { deriveLoad, priceIndex, summaryAt } from '../derive'
import { useConsole } from '../store'
import {
  Card, Failure, Legend, Loading, Note, Tile, Chip,
  dec, jobsWord, num, pct, plural, share, steps as stepsWord, usd,
} from '../ui'
import { AttentionPanel } from './AttentionPanel'
import { Bars, ContactBand, OccupancyChart, type BandCell } from './charts'
import { EventsCard } from './EventsCard'

// Six equal tiles asked the operator to decide which of them mattered. Three do:
// the obligations the shift promised, the work it got through, and the money.
// Everything else that used to be a tile is still here — in one flat strip,
// where a number is a check rather than a headline.

export function ShiftPanel({ run }: { run: RunInfo }) {
  const cursor = useConsole((s) => s.cursor)
  const setTab = useConsole((s) => s.setTab)
  const grid = useGrid(run.run_id)
  const contacts = useContacts(run.run_id)
  const feas = useFeasibility(run.run_id)
  const prices = useSlotPrices(run.run_id)

  const derived = useMemo(() => deriveLoad(grid.data, contacts.data), [grid.data, contacts.data])
  const sums = useMemo(() => summaryAt(grid.data, cursor, run.summary), [grid.data, cursor, run.summary])
  const index = useMemo(() => priceIndex(prices.data?.prices), [prices.data])

  const band: BandCell[] = useMemo(() => {
    const total = grid.data?.total_steps ?? run.total_steps
    const cells: BandCell[] = []
    for (let step = 0; step < total; step++) {
      let price = 0
      let ground: string | null = null
      for (const sid of grid.data?.satellites ?? []) {
        const hit = index.get(`${step}:${sid}`)
        if (hit && hit.price > price) { price = hit.price; ground = hit.ground }
      }
      cells.push({
        step,
        supply: derived.contactSupply[step] ?? 0,
        used: derived.load[step]?.downlink ?? 0,
        price, ground,
      })
    }
    return cells
  }, [grid.data, derived, index, run.total_steps])

  // The ceiling that means something for a finished shift is the one taken when
  // it opened: the live one only bounds what is still ahead, and at the last
  // step that is nothing at all.
  const opening = feas.data?.at_open ?? feas.data
  const ceiling = opening?.downlink_ceiling
  const certificates = opening?.totals
  const ahead = feas.data?.downlink_ceiling
  const limit = 2

  // Work steps of ground contact actually spent, up to the cursor.
  const downlinkDone = useMemo(() => {
    let done = 0
    for (let step = 0; step < Math.min(cursor, derived.load.length); step++) {
      done += derived.load[step].downlink
    }
    return done
  }, [derived.load, cursor])

  // The cursor may stand one step past the last executed one, at the very end
  // of the shift; the readout then describes the last step that happened.
  const now = derived.load[Math.min(cursor, derived.load.length - 1)]
  // The certificate footnotes describe a whole shift. Scrubbed back into the
  // middle of one, the tiles are cumulative to the cursor and must say so.
  const whole = run.finished && cursor >= run.total_steps
  const impossible = certificates?.impossible_job_count ?? 0
  const unfinished = run.summary.jobs_total - run.summary.jobs_completed
  const wasted = run.summary.work_steps_in_missed_jobs

  return (
    <>
      <Failure error={grid.error ?? contacts.error ?? feas.error} what="Данные смены не загрузились" />

      <div className="verdict-bar"
           style={{ ['--tone' as string]: run.finished ? 'var(--good)' : 'var(--accent)' }}>
        <div>
          <b>{run.finished ? 'Смена рассчитана целиком' : `Смена на шаге ${cursor}`}</b>
          <p>
            {!run.finished ? (
              <>Плитки показывают официальные показатели на шаге курсора и складываются из
                тех же приращений, что и сводка выданной библиотеки.</>
            ) : unfinished === impossible && impossible > 0 ? (
              <>Выполнено {num(run.summary.jobs_completed)} из {num(run.summary.jobs_total)} — ровно
                столько, сколько допускает сценарий: остальные {num(impossible)} {jobsWord(impossible)} имеют
                сертификат невыполнимости. Работа впустую — {wasted === 0 ? 'ноль' : stepsWord(wasted)}.</>
            ) : (
              <>Выполнено {num(run.summary.jobs_completed)} из {num(run.summary.jobs_total)}.
                Из невыполненных {num(impossible)} имеют сертификат невыполнимости, остальные{' '}
                {num(Math.max(unfinished - impossible, 0))} — потери, которые разбираются
                на экране «Задания». Работа впустую — {wasted === 0 ? 'ноль' : stepsWord(wasted)}.</>
            )}
          </p>
        </div>
        <button className="btn" onClick={() => setTab('jobs')}>Разбор потерь</button>
      </div>

      <div className="metrics">
        <Metric
          label="Обязательства П3 в срок"
          value={num(sums.critical_jobs_completed_on_time)}
          of={num(sums.critical_jobs_due)}
          fill="var(--good)"
          share={share(sums.critical_jobs_completed_on_time, sums.critical_jobs_due)}
          foot={whole && certificates
            ? <>{num(certificates.impossible_critical_count)} недостижимы по сертификату</>
            : <>{pct(share(sums.critical_jobs_completed_on_time, sums.critical_jobs_due))} обязательств к курсору</>}
        />
        <Metric
          label="Выполнено заданий"
          value={num(sums.jobs_completed)}
          of={num(sums.jobs_total)}
          fill="var(--s1)"
          share={share(sums.jobs_completed, sums.jobs_total)}
          // The identity holds only where the planner actually reached the
          // ceiling. Printing it on a shift that fell short of the ceiling
          // states an arithmetic that does not add up, so the shortfall is
          // named instead — that distinction is the whole point of the tile.
          foot={whole && impossible > 0
            ? unfinished === impossible
              ? <>Ровно {num(run.summary.jobs_total)} − {num(impossible)} невыполнимых</>
              : <>Потолок {num(run.summary.jobs_total - impossible)}: {num(impossible)} невыполнимы
                  по сертификату, не добрано {num(unfinished - impossible)}</>
            : <>Нарастающим итогом к курсору</>}
        />
        <Metric
          label="Выручка"
          value={usd(sums.revenue_usd)}
          fill="var(--s3)"
          share={share(sums.revenue_usd, run.summary.revenue_usd)}
          barTitle="Доля выручки, набранной к курсору, от набранной за исполненную историю"
          foot={<>цель управления: {run.goal === 'priority' ? 'приоритет' : 'выручка'}</>}
        />
      </div>

      <div className="secondary">
        <Second k="Просрочено" v={num(sums.jobs_due_missed)}
                tone={sums.jobs_due_missed > 0 ? 'var(--serious)' : 'var(--good)'} />
        <Second k="Работа впустую" v={stepsWord(wasted)}
                tone={wasted > 0 ? 'var(--warn)' : 'var(--good)'} />
        <Second k="Отклонённые команды" v={num(run.summary.blocked_command_count)}
                tone={run.summary.blocked_command_count > 0 ? 'var(--crit)' : 'var(--good)'} />
        <Second k="Минимальный заряд" v={pct(run.summary.minimum_soc_pct)} />
        <Second k="Ниже резерва" v={stepsWord(run.summary.below_reserve_satellite_steps)}
                tone={run.summary.below_reserve_satellite_steps > 0 ? 'var(--crit)' : 'var(--good)'} />
      </div>

      <div className="overview-two">
        <AttentionPanel run={run} />

        <Card title="Потолок выполнимости"
              note="Верхняя граница по связи на момент открытия смены: сколько работы вообще укладывается в окна контактов при лимите двух передач на шаг.">
          {feas.isPending || !ceiling ? <Loading what="Сертификаты" /> : (
            <>
              <Bars height={9} rows={[
                { label: 'Запрошено работы', value: ceiling.work_steps_demanded,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--ink-3)',
                  note: stepsWord(ceiling.work_steps_demanded) },
                { label: 'Укладывается в окна', value: ceiling.work_steps_schedulable,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--s1)',
                  note: stepsWord(ceiling.work_steps_schedulable) },
                { label: 'Передано на курсоре', value: downlinkDone,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--good)',
                  note: stepsWord(downlinkDone) },
              ]} />
              <Note>
                <span>
                  Недостижимо по окнам: <b>{num(ceiling.jobs_unreachable_by_window)}</b>{' '}
                  {jobsWord(ceiling.jobs_unreachable_by_window)}
                  {certificates && <>, из них приоритета 3 — <b>{num(certificates.impossible_critical_count)}</b>,
                    на <b>{usd(certificates.impossible_value_usd)}</b></>}.
                  У каждого есть сертификат против данных; из знаменателя метрик они не вычитаются.
                </span>
              </Note>
              <p className="tbl-note">
                Передано <b>{pct(share(downlinkDone, ceiling.work_steps_schedulable))}</b> от потолка
                и <b>{pct(share(downlinkDone, ceiling.work_steps_demanded))}</b> от запрошенного.
                Разница между двумя числами — не качество планировщика, а свойство сценария.
                {ahead && ahead.work_steps_demanded > 0 && <> Впереди курсора ещё достижимо{' '}
                  <b>{num(ahead.work_steps_schedulable)}</b>{' '}
                  {plural(ahead.work_steps_schedulable, 'шаг', 'шага', 'шагов')} работы из{' '}
                  <b>{num(ahead.work_steps_demanded)}</b> запрошенных.</>}
              </p>
            </>
          )}
        </Card>
      </div>

      <Card title="Наземная связь: где узкое место"
            note="Верхняя полоса — окна контакта и их использование при лимите двух передач на шаг. Нижняя — цена слота: лучшее задание, которое на этот контакт претендовало и осталось невыполненным."
            right={<Legend items={[
              { color: 'var(--s1)', label: 'Контакт использован' },
              { color: 'var(--idle)', label: 'Свободен' },
              { color: 'var(--serious)', label: 'Претендент недостижим' },
              { color: 'var(--crit)', label: 'Претендент снят отбором' },
            ]} />}>
        {prices.isPending ? <Loading what="Цена слотов" /> : (
          <>
            <ContactBand cells={band} cursor={cursor} limit={limit}
                         onPick={(step) => useConsole.getState().setCursor(step)} />
            {prices.data?.prices ? (
              <div className="readout">
                <span>Контактов за смену <b>{num(prices.data.prices.totals.contact_slots)}</b></span>
                <span>Занято <b>{num(prices.data.prices.totals.slots_assigned)}</b></span>
                <span>Свободно <b>{num(prices.data.prices.totals.slots_unused)}</b></span>
                <span>С ненулевой ценой <b>{num(prices.data.prices.totals.slots_priced)}</b></span>
                <span>Дороже всего <b>{usd(prices.data.prices.totals.price_max_usd)}</b></span>
                <span>В среднем <b>{usd(prices.data.prices.totals.price_mean_usd)}</b></span>
              </div>
            ) : (
              <Note><span>
                Этот планировщик не держит расписание связи заранее, поэтому цену слота считать
                не из чего. Откройте смену планировщиком <b>cosmostars</b>, чтобы увидеть полосу.
              </span></Note>
            )}
            {prices.data?.prices && prices.data.prices.totals.slots_idle_for_certified_job > 0 && (
              <p className="tbl-note">
                Из свободных контактов <b>{num(prices.data.prices.totals.slots_idle_for_certified_job)}</b>{' '}
                пустуют потому, что единственный претендент физически не успевает закончить в своём
                окне, а частично выполненное задание не оплачивается. Занять такой слот — значит
                потратить работу впустую, и планировщик этого не делает.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="Чем занята группировка"
            note="Столбец — один шаг: сколько аппаратов передаёт на Землю, ретранслирует, калибруется. Правее курсора — ещё не исполнено."
            right={<Legend items={[
              { color: 'var(--s1)', label: 'Связь' },
              { color: 'var(--s3)', label: 'Ретрансляция' },
              { color: 'var(--s2)', label: 'Калибровка' },
              { color: 'var(--crit)', label: 'Отклонено' },
            ]} />}>
        {grid.isPending ? <Loading what="Сетка смены" /> : (
          <>
            <OccupancyChart load={derived.load} cursor={cursor} satellites={derived.satellites} />
            <div className="readout">
              <span>На шаге курсора в работе <b>{num((now?.downlink ?? 0) + (now?.relay ?? 0))}</b> из {derived.satellites}</span>
              <span>Связь <b>{num(now?.downlink ?? 0)}</b> из {limit}</span>
              <span>Калибровка <b>{num(now?.calibrate ?? 0)}</b></span>
            </div>
          </>
        )}
      </Card>

      <EventsCard run={run} />

      <Card title="Что доказано невыполнимым"
            note="Сертификаты выдаются против сценария, а не против нашего расписания: событие может только убрать контакт, поэтому выданный сертификат остаётся верным до конца смены.">
        {feas.isPending || !opening ? <Loading what="Сертификаты" /> : (
          <div className="cert-grid">
            <div className="tiles">
              <Tile label="Заданий с сертификатом" value={num(opening.totals.impossible_job_count)}
                    foot="Окно короче, чем объём работы" />
              <Tile label="Из них приоритета 3" value={num(opening.totals.impossible_critical_count)}
                    foot="Обязательства, недостижимые в принципе" />
              <Tile label="Цена невыполнимого" value={usd(opening.totals.impossible_value_usd)}
                    foot="Не вычитается из знаменателя метрик" />
              <Tile label="Аппаратов с дефицитом группы"
                    value={num(opening.totals.satellites_with_group_shortfall)}
                    foot={<>Условие Холла · не хватает {stepsWord(opening.totals.group_shortfall_work_steps)}</>} />
            </div>
            {!!opening.oversubscribed_satellites.length && (
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Аппарат</th><th>Интервал</th><th className="num">Заданий</th>
                        <th className="num">Нужно работы</th><th className="num">Контактов</th>
                        <th className="num">Дефицит</th></tr>
                  </thead>
                  <tbody>
                    {opening.oversubscribed_satellites.slice(0, 12).map((item, i) => (
                      <tr key={i}>
                        <td className="id">{item.satellite_id}</td>
                        <td className="id">{item.interval?.[0]}–{item.interval?.[1]}</td>
                        <td className="num">{item.jobs?.length}</td>
                        <td className="num">{item.work_required}</td>
                        <td className="num">{item.contacts_in_interval}</td>
                        <td className="num"><Chip tone="ser">{item.shortfall}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="tbl-note">
              Потолок смены по связи — <b>{num(ceiling?.work_steps_schedulable)}</b>{' '}
              {plural(ceiling?.work_steps_schedulable ?? 0, 'шаг', 'шага', 'шагов')} работы
              из запрошенных <b>{num(ceiling?.work_steps_demanded)}</b>
              {ceiling && ceiling.work_steps_demanded > 0 && <> ({dec(share(ceiling.work_steps_schedulable, ceiling.work_steps_demanded))}%)</>}.
              Невыполнимые задания остаются в знаменателе официальных метрик: вычёркивать их
              описание данных прямо запрещает.
            </p>
          </div>
        )}
      </Card>
    </>
  )
}

/** One of the three headline figures: a number, its denominator, one bar, one line. */
function Metric({ label, value, of, fill, share: filled, foot, barTitle }: {
  label: ReactNode; value: ReactNode; of?: ReactNode; fill: string
  share: number; foot: ReactNode; barTitle?: string
}) {
  return (
    <div className="metric">
      <span className="k">{label}</span>
      <span className="v">
        <b>{value}</b>
        {of !== undefined && <span>/ {of}</span>}
      </span>
      <div className="metric-bar" title={barTitle}>
        <i style={{ width: `${Math.max(0, Math.min(100, filled))}%`, background: fill }} />
      </div>
      <span className="d">{foot}</span>
    </div>
  )
}

function Second({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) {
  return (
    <div>
      <span>{k}</span>
      <b style={tone ? { color: tone } : undefined}>{v}</b>
    </div>
  )
}
