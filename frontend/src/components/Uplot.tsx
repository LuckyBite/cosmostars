import { useEffect, useRef } from 'react'
import uPlot from 'uplot'

// A thin binding to uPlot: it draws 288-point series with real axes and a
// crosshair far more sharply than a hand-rolled SVG would, and it is small
// enough not to be a dependency worth arguing about.

export interface PlotProps {
  data: uPlot.AlignedData
  options: Omit<uPlot.Options, 'width' | 'height'> & { height: number }
  /** Step to mark with a vertical rule: the cursor of the shift. */
  mark?: number
}

export function Plot({ data, options, mark }: PlotProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = new uPlot(
      {
        ...options,
        width: host.clientWidth || 600,
        height: options.height,
        hooks: {
          ...options.hooks,
          draw: [
            ...(options.hooks?.draw ?? []),
            (self) => {
              if (mark === undefined) return
              const x = self.valToPos(mark, 'x', true)
              const context = self.ctx
              context.save()
              context.strokeStyle = getComputedStyle(host).getPropertyValue('--ink').trim()
              context.lineWidth = 1
              context.beginPath()
              context.moveTo(x, self.bbox.top)
              context.lineTo(x, self.bbox.top + self.bbox.height)
              context.stroke()
              context.restore()
            },
          ],
        },
      },
      data,
      host,
    )
    chartRef.current = chart
    const observer = new ResizeObserver(([entry]) =>
      chart.setSize({ width: entry.contentRect.width, height: options.height }))
    observer.observe(host)
    return () => {
      observer.disconnect()
      chart.destroy()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, options.height, mark])

  return <div className="plot" ref={hostRef} />
}
