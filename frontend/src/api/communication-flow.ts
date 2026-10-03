import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 通讯设备单向处置流程：通讯正常 → 信号弱 → 通讯中断 → 待更换 →（更换完成）→ 通讯正常。
// 已停用是终态，不参与流转。除「更换完成后恢复」外不允许任何往回走或跳级的流转。
//
// 人工抢修与自动质量结论冲突时的优先级约定：人工抢修结论优先。
// 理由：人工抢修是现场核实后的结论，自动回放可能受瞬时信号影响；
// 自动结论只记录备查，不覆盖人工结论，直到下一个故障回合开始（重新登记故障/停用）。

export const COMM_KEY = 'communication'
export const FAULT_KEY = 'commfault'
export const STATIONHOUSE_KEY = 'stationhouse'

const ST_NORMAL = '通讯正常'
const ST_WEAK = '信号弱'
const ST_DOWN = '通讯中断'
const ST_REPLACE = '待更换'
const ST_RETIRED = '已停用'

const ACT_REPORT = '登记故障'
const ACT_REPLACE = '申请更换'
const ACT_REPAIR = '人工抢修'
const ACT_REPLAY = '自动回放'
const ACT_RETIRE = '停用设备'

// 单向流转表：动作 → { 允许的当前状态: 目标状态 }，不在表里的来源一律拒绝。
const TRANSITIONS: Record<string, Record<string, string>> = {
  // 只有正常或弱信号可登记故障
  [ACT_REPORT]: { [ST_NORMAL]: ST_DOWN, [ST_WEAK]: ST_DOWN },
  // 必须先确认中断才能申请更换，禁止跳级
  [ACT_REPLACE]: { [ST_DOWN]: ST_REPLACE },
  // 更换完成后才能恢复通讯正常
  [ACT_REPAIR]: { [ST_REPLACE]: ST_NORMAL },
  [ACT_RETIRE]: {
    [ST_NORMAL]: ST_RETIRED,
    [ST_WEAK]: ST_RETIRED,
    [ST_DOWN]: ST_RETIRED,
    [ST_REPLACE]: ST_RETIRED,
  },
}

// 自动质量结论的判定阈值：超过 24 小时无通讯判中断，信号强度低于 60 判弱。
const OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000
const WEAK_SIGNAL_BELOW = 60

// 故障单未办结状态、站房待办未办结状态：命中即视为已有在办单据，不重复建单。
const TICKET_OPEN_STATUSES = ['待处理', '处理中']
const TODO_OPEN_STATUSES = ['待安排', '已安排', '施工中']

function pad(num: number): string {
  return String(num).padStart(4, '0')
}

function pad2(num: number): string {
  return String(num).padStart(2, '0')
}

function fmtDateTime(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtDate(time: number): string {
  return fmtDateTime(time).slice(0, 10)
}

function parseMoment(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  ).getTime()
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function deviceCode(row: EntryRow): string {
  return String(row['设备编号'] ?? row.id)
}

// 历史设备缺少最近通讯时刻时按安装日期回填；有改动就落库，返回是否有回填。
export function backfillCommRows(): boolean {
  const rows = listRows(COMM_KEY)
  let changed = false
  const next = rows.map((row) => {
    const last = String(row['最近通讯时刻'] ?? '').trim()
    const installed = String(row['安装日期'] ?? '').trim()
    if (last === '' && installed !== '') {
      changed = true
      return { ...row, 最近通讯时刻: installed }
    }
    return row
  })
  if (changed) {
    saveRows(COMM_KEY, next)
  }
  return changed
}

function openTicketFor(code: string): EntryRow | undefined {
  return listRows(FAULT_KEY).find(
    (row) => String(row['设备编号']) === code && TICKET_OPEN_STATUSES.includes(String(row.status)),
  )
}

function openStationhouseTodoFor(code: string): EntryRow | undefined {
  return listRows(STATIONHOUSE_KEY).find(
    (row) =>
      String(row['维护类型']) === '站房巡检' &&
      String(row['维护内容']).includes(code) &&
      TODO_OPEN_STATUSES.includes(String(row.status)),
  )
}

// 确认通讯中断后的同步动作：生成通讯故障单 + 站房巡检待办。
// 同一设备已有未办结单据时跳过，重复回放不会重复建单。
function confirmInterruption(device: EntryRow, now: number): string {
  const code = deviceCode(device)
  const parts: string[] = []

  const tickets = listRows(FAULT_KEY)
  if (openTicketFor(code)) {
    parts.push('该设备已有未办结通讯故障单，不重复建单')
  } else {
    const id = nextId(tickets)
    const ticketNo = `COMMF-${pad(id)}`
    tickets.push({
      id,
      status: '待处理',
      pending: true,
      abnormal: false,
      工单编号: ticketNo,
      设备编号: code,
      所属站点: String(device['所属站点'] ?? ''),
      故障类型: ST_DOWN,
      登记时间: fmtDateTime(now),
      处置人: String(device['维护人员'] ?? ''),
      工单状态: '待处理',
    })
    saveRows(FAULT_KEY, tickets)
    parts.push(`已同步生成通讯故障单 ${ticketNo}`)
  }

  const houses = listRows(STATIONHOUSE_KEY)
  if (openStationhouseTodoFor(code)) {
    parts.push('该设备的站房巡检待办已存在，不重复生成')
  } else {
    const id = nextId(houses)
    houses.push({
      id,
      status: '待安排',
      pending: true,
      abnormal: false,
      记录编号: `STAT-${pad(id)}`,
      站点编号: String(device['所属站点'] ?? ''),
      维护类型: '站房巡检',
      维护内容: `通讯设备 ${code} 通讯中断，需到站房巡检处置`,
      维护单位: '通讯运维班',
      维护日期: fmtDate(now),
      费用支出: 0,
      维护状态: '待安排',
    })
    saveRows(STATIONHOUSE_KEY, houses)
    parts.push('已同步生成站房巡检待办')
  }

  return parts.join('；')
}

// 设备恢复通讯正常后，同设备未办结的故障单同步办结。
function closeTicketsOnRecover(code: string): number {
  const tickets = listRows(FAULT_KEY)
  let closed = 0
  const next = tickets.map((row) => {
    if (String(row['设备编号']) === code && TICKET_OPEN_STATUSES.includes(String(row.status))) {
      closed += 1
      return { ...row, status: '已恢复', pending: false, 工单状态: '已恢复' }
    }
    return row
  })
  if (closed > 0) {
    saveRows(FAULT_KEY, next)
  }
  return closed
}

// 自动质量结论：按最近通讯时刻与信号强度得出。
function autoVerdict(row: EntryRow, now: number): string {
  const last = parseMoment(row['最近通讯时刻'])
  if (last === null || now - last > OFFLINE_AFTER_MS) {
    return ST_DOWN
  }
  const signal = Number.parseFloat(String(row['信号强度'] ?? ''))
  if (Number.isNaN(signal) || signal < WEAK_SIGNAL_BELOW) {
    return ST_WEAK
  }
  return ST_NORMAL
}

function rejectMessage(action: string, current: string): string {
  if (action === ACT_REPORT) {
    return `只有「通讯正常」或「信号弱」可登记故障，当前「${current}」，已拒绝`
  }
  if (action === ACT_REPLACE) {
    return `须先确认通讯中断才能申请更换，当前「${current}」，跳级操作已拒绝`
  }
  if (action === ACT_REPAIR) {
    return `更换完成后才能恢复通讯正常，当前「${current}」，跳级操作已拒绝`
  }
  return `当前「${current}」不允许执行「${action}」，已拒绝`
}

function clearManual(row: EntryRow): EntryRow {
  return { ...row, 人工结论: '', 人工结论时间: '' }
}

function replayDevice(rows: EntryRow[], index: number, now: number): ActionResult {
  const device = rows[index]
  const current = String(device.status)
  const code = deviceCode(device)
  if (current === ST_RETIRED) {
    return { ok: false, message: `设备 ${code} 已停用，不参与自动质量判定，不得判为通讯正常` }
  }
  const verdict = autoVerdict(device, now)
  const manual = String(device['人工结论'] ?? '')
  const base: EntryRow = { ...device, 自动结论: verdict, 自动结论时间: fmtDateTime(now) }

  // 人工抢修结论与自动质量结论冲突：人工优先，自动结论仅记录备查。
  if (manual !== '' && manual !== verdict) {
    rows[index] = base
    saveRows(COMM_KEY, rows)
    return {
      ok: true,
      message: `自动回放结论「${verdict}」与人工抢修结论「${manual}」冲突，按人工优先处理，设备状态保持「${current}」`,
    }
  }

  // 自动结论与人工结论一致：人工结论已被确认，清除后回归自动判定。
  const confirmed = manual !== '' && manual === verdict
  const aligned = confirmed ? clearManual(base) : base

  if (current === ST_REPLACE) {
    rows[index] = { ...aligned, 质量结论: `自动回放：${verdict}` }
    saveRows(COMM_KEY, rows)
    return { ok: true, message: `自动回放结论「${verdict}」；设备待更换，恢复须人工抢修确认，状态不变` }
  }

  const order = [ST_NORMAL, ST_WEAK, ST_DOWN]
  if (order.indexOf(verdict) <= order.indexOf(current)) {
    // 自动结论不往回流转：弱/中断要恢复正常，必须走更换完成后人工抢修确认。
    rows[index] = { ...aligned, 质量结论: `自动回放：${verdict}` }
    saveRows(COMM_KEY, rows)
    const note =
      verdict === ST_NORMAL && current !== ST_NORMAL
        ? `当前「${current}」不能由自动结论直接恢复，须更换完成后人工抢修确认`
        : `当前「${current}」，状态保持不变`
    return { ok: true, message: `自动回放结论「${verdict}」，${note}` }
  }

  // 单向前进：正常 → 弱 → 中断。
  const updated: EntryRow = {
    ...aligned,
    status: verdict,
    pending: true,
    abnormal: true,
    质量结论: `自动回放：${verdict}`,
  }
  rows[index] = updated
  const extra = verdict === ST_DOWN ? `；${confirmInterruption(updated, now)}` : ''
  saveRows(COMM_KEY, rows)
  return { ok: true, message: `自动回放结论「${verdict}」，设备已流转${extra}` }
}

export function applyCommunicationAction(id: number, action: string): ActionResult {
  // 先回填再处置：回放判定与故障单都要用最近通讯时刻。
  backfillCommRows()
  const now = Date.now()
  const rows = listRows(COMM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的通讯设备` }
  }
  const device = rows[index]
  const current = String(device.status)

  if (action === ACT_REPLAY) {
    return replayDevice(rows, index, now)
  }

  const transitions = TRANSITIONS[action]
  if (!transitions) {
    return { ok: false, message: `通讯设备没有登记「${action}」这个动作` }
  }
  if (current === ST_RETIRED) {
    return { ok: false, message: '设备已停用，不参与处置流转，不得判为通讯正常' }
  }
  const target = transitions[current]
  if (!target) {
    return { ok: false, message: rejectMessage(action, current) }
  }

  const code = deviceCode(device)
  let updated: EntryRow = clearManual(device)
  let message = ''
  if (action === ACT_REPORT) {
    updated = { ...updated, status: target, pending: true, abnormal: true }
    rows[index] = updated
    message = `通讯设备已登记故障，当前状态「${ST_DOWN}」；${confirmInterruption(updated, now)}`
  } else if (action === ACT_REPLACE) {
    updated = { ...updated, status: target, pending: true, abnormal: true }
    rows[index] = updated
    message = `通讯设备已申请更换，当前状态「${ST_REPLACE}」`
  } else if (action === ACT_REPAIR) {
    const closed = closeTicketsOnRecover(code)
    updated = {
      ...updated,
      status: target,
      pending: false,
      abnormal: false,
      最近通讯时刻: fmtDateTime(now),
      人工结论: ST_NORMAL,
      人工结论时间: fmtDateTime(now),
      质量结论: `人工抢修：${ST_NORMAL}`,
    }
    rows[index] = updated
    const ticketNote = closed > 0 ? `；同设备 ${closed} 张未办结故障单已同步办结` : ''
    message = `人工抢修确认：更换完成，设备恢复「${ST_NORMAL}」${ticketNote}`
  } else {
    updated = { ...updated, status: target, pending: false, abnormal: true, 质量结论: '人工停用：已停用' }
    rows[index] = updated
    message = '通讯设备已停用，停用设备不参与自动质量判定'
  }
  saveRows(COMM_KEY, rows)
  return { ok: true, message }
}
