import { useMemo } from 'react'
import { useContacts, useFeasibility, useGrid, useSlotPrices } from '../api/client'
import type { RunInfo } from '../api/types'
import { deriveLoad, priceIndex, summaryAt } from '../derive'
import { useConsole } from '../store'
import { Card, Chip, Failure, Legend, Loading, Note, Tile, dec, num, pct, share, usd } from '../ui'
import { Bars, ContactBand, OccupancyChart, type BandCell } from './charts'
import { EventsCard } from './EventsCard'

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

  return (
    <>
      <Failure error={grid.error ?? contacts.error ?? feas.error} what="Данные смены не загрузились" />

      <div className="tiles">
        <Tile label="Выполнено заданий" value={num(sums.jobs_completed)}
              foot={<>из {num(sums.jobs_total)} в смене</>} />
        <Tile label="Приоритет 3 в срок" value={num(sums.critical_jobs_completed_on_time)}
              unit={`/ ${num(sums.critical_jobs_due)}`}
              foot={<><b>{pct(share(sums.critical_jobs_completed_on_time, sums.critical_jobs_due))}</b> обязательств</>}
              tone={sums.critical_jobs_completed_on_time === sums.critical_jobs_due ? 'up' : undefined} />
        <Tile label="Выручка" value={usd(sums.revenue_usd)}
              foot={<>цель управления: {run.goal === 'priority' ? 'приоритет' : 'выручка'}</>} />
        <Tile label="Просрочено" value={num(sums.jobs_due_missed)}
              foot={<>из {num(sums.jobs_due)} с истёкшим сроком</>}
              tone={sums.jobs_due_missed > 0 ? 'down' : 'up'} />
        <Tile label="Отклонённые команды" value={num(run.summary.blocked_command_count)}
              foot={run.summary.blocked_command_count === 0
                ? 'ни одна команда не отклонена' : 'см. журнал аппаратов'}
              tone={run.summary.blocked_command_count === 0 ? 'up' : 'down'} />
        <Tile label="Минимальный заряд" value={pct(run.summary.minimum_soc_pct)}
              foot={<>ниже резерва: {num(run.summary.below_reserve_satellite_steps)} аппарато-шагов</>}
              tone={run.summary.below_reserve_satellite_steps === 0 ? 'up' : undefined} />
      </div>

      <p className="tbl-note">
        Плитки показывают официальные показатели на шаге курсора — <b>{cursor}</b>. Они сложены из
        тех же приращений, которыми их считает выданная библиотека, поэтому совпадают с её сводкой
        шаг в шаг. Счётчики ниже — за всю исполненную историю.
      </p>

      <div className="two">
        <Card title="Чем занята группировка"
              note="Столбец — один шаг: сколько аппаратов передаёт на Землю, ретранслирует, калибруется. Правее курсора — ещё не исполнено."
              right={<Legend items={[
                { color: 'var(--s1)', label: 'связь' },
                { color: 'var(--s3)', label: 'ретрансляция' },
                { color: 'var(--s2)', label: 'калибровка' },
                { color: 'var(--crit)', label: 'отклонено' },
              ]} />}>
          {grid.isPending ? <Loading what="Сетка смены" /> : (
            <>
              <OccupancyChart load={derived.load} cursor={cursor} satellites={derived.satellites} />
              <div className="readout">
                <span>на шаге курсора в работе <b>{num((derived.load[cursor]?.downlink ?? 0) + (derived.load[cursor]?.relay ?? 0))}</b> из {derived.satellites}</span>
                <span>связь <b>{num(derived.load[cursor]?.downlink ?? 0)}</b> из {limit}</span>
                <span>калибровка <b>{num(derived.load[cursor]?.calibrate ?? 0)}</b></span>
              </div>
            </>
          )}
        </Card>

        <Card title="Потолок выполнимости"
              note="Верхняя граница по связи, посчитанная при открытии смены: сколько работы вообще можно уложить в окна контактов при лимите двух передач на шаг. Показывается рядом с честными метриками, а не вместо них.">
          {feas.isPending || !ceiling ? <Loading what="Сертификаты" /> : (
            <>
              <Bars rows={[
                { label: 'запрошено работы', value: ceiling.work_steps_demanded,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--ink-3)',
                  note: num(ceiling.work_steps_demanded) + ' шагов' },
                { label: 'укладывается в окна', value: ceiling.work_steps_schedulable,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--s1)',
                  note: num(ceiling.work_steps_schedulable) + ' шагов' },
                { label: 'передано на курсоре', value: downlinkDone,
                  max: Math.max(ceiling.work_steps_demanded, 1), fill: 'var(--good)',
                  note: num(downlinkDone) + ' шагов' },
              ]} />
              <p className="tbl-note">
                Это <b>{pct(share(downlinkDone, ceiling.work_steps_schedulable))}</b> от потолка
                и <b>{pct(share(downlinkDone, ceiling.work_steps_demanded))}</b> от запрошенного.
                Разница между двумя числами — не качество планировщика, а свойство сценария.
                {ahead && ahead.work_steps_demanded > 0 && <> Впереди курсора ещё достижимо{' '}
                  <b>{num(ahead.work_steps_schedulable)}</b> шагов работы из{' '}
                  <b>{num(ahead.work_steps_demanded)}</b> запрошенных.</>}
              </p>
              <Note>
                <span>
                  Недостижимо по окнам: <b>{num(ceiling.jobs_unreachable_by_window)}</b> заданий
                  {certificates && <> на <b>{usd(certificates.impossible_value_usd)}</b>, из них
                    приоритета 3 — <b>{num(certificates.impossible_critical_count)}</b></>}.
                  Это свойство сценария, а не качество планировщика: у каждого такого задания есть
                  сертификат, который выдан против данных и проверяется без нашего кода.
                </span>
              </Note>
              <button className="btn" onClick={() => setTab('jobs')}>
                открыть разбор заданий
              </button>
            </>
          )}
        </Card>
      </div>

      <Card title="Наземная связь: где узкое место"
            note="Верхняя полоса — окна контакта и их использование при лимите двух передач на шаг. Нижняя — цена слота: лучшее задание, которое на этот контакт претендовало и осталось невыполненным."
            right={<Legend items={[
              { color: 'var(--s1)', label: 'контакт использован' },
              { color: 'var(--idle)', label: 'контакт свободен' },
              { color: 'var(--serious)', label: 'претендент недостижим по окну' },
              { color: 'var(--crit)', label: 'претендент снят отбором' },
            ]} />}>
        {prices.isPending ? <Loading what="Цена слотов" /> : (
          <>
            <ContactBand cells={band} cursor={cursor} limit={limit}
                         onPick={(step) => useConsole.getState().setCursor(step)} />
            {prices.data?.prices ? (
              <div className="readout">
                <span>контактов за смену <b>{num(prices.data.prices.totals.contact_slots)}</b></span>
                <span>занято <b>{num(prices.data.prices.totals.slots_assigned)}</b></span>
                <span>свободно <b>{num(prices.data.prices.totals.slots_unused)}</b></span>
                <span>с ненулевой ценой <b>{num(prices.data.prices.totals.slots_priced)}</b></span>
                <span>дороже всего <b>{usd(prices.data.prices.totals.price_max_usd)}</b></span>
                <span>в среднем <b>{usd(prices.data.prices.totals.price_mean_usd)}</b></span>
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

      <EventsCard run={run} />

      <Card title="Что доказано невыполнимым"
            note="Сертификаты выдаются против сценария, а не против нашего расписания: событие может только убрать контакт, поэтому выданный сертификат остаётся верным до конца смены.">
        {feas.isPending || !opening ? <Loading what="Сертификаты" /> : (
          <div className="cert-grid">
            <div className="tiles">
              <Tile label="Заданий с сертификатом" value={num(opening.totals.impossible_job_count)}
                    foot="окно короче, чем объём работы" />
              <Tile label="Из них приоритета 3" value={num(opening.totals.impossible_critical_count)}
                    foot="обязательства, недостижимые в принципе" />
              <Tile label="Цена невыполнимого" value={usd(opening.totals.impossible_value_usd)}
                    foot="не вычитается из знаменателя метрик" />
              <Tile label="Аппаратов с дефицитом группы"
                    value={num(opening.totals.satellites_with_group_shortfall)}
                    foot={<>условие Холла · не хватает {num(opening.totals.group_shortfall_work_steps)} шагов</>} />
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
              Потолок смены по связи — <b>{num(ceiling?.work_steps_schedulable)}</b> шагов
              работы из запрошенных <b>{num(ceiling?.work_steps_demanded)}</b>
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
