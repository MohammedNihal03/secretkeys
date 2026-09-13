/**
 * The chart set.
 *
 * Three shapes, chosen by what the number is rather than by what looks best:
 *
 * - `LineChart` for a *level* sampled over time -- response time, connection
 *   count, transactions per second. The line implies the value existed between
 *   the samples too, which is true of a level and false of a count.
 * - `BarChart` for a *quantity per interval* -- requests per day, tokens per
 *   day. Each bar is a thing that accumulated, and nothing is implied between
 *   them.
 * - `DonutChart` for *composition* -- cost by provider, connections by state.
 *   It refuses to present a partial total as a whole one.
 *
 * Every one is a server component. Twenty data points do not need a runtime,
 * and a charting library would weigh more than the rest of the page.
 */

export { LineChart, EmptyPlot, type LineChartProps } from './line-chart';
export { BarChart, type BarChartProps } from './bar-chart';
export { DonutChart, type DonutChartProps } from './donut-chart';
export {
  SERIES_COLORS,
  defaultFormat,
  extent,
  plotBand,
  seriesColor,
  type ChartPoint,
  type ChartSlice,
  type Formatter,
} from './types';
