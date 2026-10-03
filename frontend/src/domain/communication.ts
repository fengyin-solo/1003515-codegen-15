import type { EntryRow } from '@/data/types'

// 通讯设备处置域逻辑（纯函数，不碰 localStorage，方便单测）。
//
// 单向处置流程：通讯正常 → 信号弱 → 通讯中断 → 待更换，更换完成后才能确认恢复回通讯正常；
// 已停用为终态。规则要点：
// - 只有通讯正常或信号弱可登记故障，且沿流程逐级推进一步，跳级状态一律拒绝；
// - 只有通讯中断可申请更换，只有待更换可确认恢复（更换完成后才能恢复）；
// - 确认中断（进入通讯中断）时，通讯故障单与站房巡检待办同步生成；
//   同一设备已有未办结故障单时不重复建单，重复回放同一设备幂等；
// - 人工抢修（确认恢复）与自动质量结论冲突时，人工结论优先：
//   自动证据（最近通讯时刻）早于人工结论时刻的，自动研判不推翻人工结论；
// - 历史设备缺少最近通讯时刻按安装日期回填；
// - 停用设备不得被判为正常：不参与自动研判，也拒绝一切处置动作。
//
// 说明：跳级拒绝只约束人工处置动作；自动质量研判按证据直接给出结论，
// 但只沿单向流程向前推进，绝不自动回退（恢复必须走更换完成后的确认恢复）。

export const COMM_FLOW = ['通讯正常', '信号弱', '通讯中断', '待更换'] as const
export const COMM_NORMAL = '通讯正常'
export const COMM_WEAK = '信号弱'
export const COMM_OUTAGE = '通讯中断'
export const COMM_PENDING_REPLACE = '待更换'
export const COMM_DECOMMISSIONED = '已停用'

export const COMM_ACTIONS = ['登记故障', '申请更换', '确认恢复', '停用设备'] as const

// 自动研判阈值：静默 6 小时判信号弱，24 小时判通讯中断；信号强度 ≤ -100dBm 判信号弱。
export const WEAK_SILENCE_HOURS = 6
export const OUTAGE_SILENCE_HOURS = 24
export const WEAK_SIGNAL_DBM = -100

export const FAULT_TICKET_TYPE = '通讯中断'
export const STATION_TODO_TYPE = '通讯巡检'

export type CommState = {
  devices: EntryRow[]
  tickets: EntryRow[] // 通讯故障单（commfault 模块）
  stationTodos: EntryRow[] // 站房巡检待办（stationhouse 模块）
}

export type CommTransition = {
  ok: boolean
  message: string
  state: CommState
  events: string[]
}

export type AutoConclusion = {
  conclusion: string
  evidence: string
  evidenceTime: number | null
}

export type AutoEvalItem = {
  deviceId: number
  deviceCode: string
  from: string
  conclusion: string
  applied: boolean
  note: string
}

const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/

export function parseTimeValue(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = value.trim().match(TIME_PATTERN)
  if (!match) {
    return null
  }
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
  const time = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime()
  return Number.isNaN(time) ? null : time
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateTime(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatDate(time: number): string {
  return formatDateTime(time).slice(0, 10)
}

export function parseSignalDbm(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) {
    return null
  }
  // 只接受 dBm 描述或纯数字，避免把「无信号」之外的描述文本误判成数值
  if (!/dbm/i.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) {
    return null
  }
  return Number(match[0])
}

// 历史设备缺少最近通讯时刻，按安装日期回填。
export function backfillLastComm(row: EntryRow): { row: EntryRow; backfilled: boolean } {
  const current = String(row['最近通讯时刻'] ?? '').trim()
  if (current !== '') {
    return { row, backfilled: false }
  }
  const installDate = String(row['安装日期'] ?? '').trim()
  if (installDate === '') {
    return { row, backfilled: false }
  }
  return { row: { ...row, 最近通讯时刻: installDate }, backfilled: true }
}

// 自动质量结论：按最近通讯时刻（已回填）与信号强度推断。
export function autoConclusionOf(row: EntryRow, now: number): AutoConclusion {
  const status = String(row.status)
  if (status === COMM_DECOMMISSIONED) {
    // 停用设备不得被判为正常：不参与自动研判，结论保持已停用。
    return { conclusion: COMM_DECOMMISSIONED, evidence: '设备已停用，不参与自动研判', evidenceTime: null }
  }
  const lastComm = parseTimeValue(row['最近通讯时刻'])
  if (lastComm === null) {
    return {
      conclusion: status,
      evidence: '缺少最近通讯时刻与安装日期，证据不足，维持原状态',
      evidenceTime: null,
    }
  }
  const silenceHours = (now - lastComm) / 3_600_000
  if (silenceHours >= OUTAGE_SILENCE_HOURS) {
    return {
      conclusion: COMM_OUTAGE,
      evidence: `已静默 ${silenceHours.toFixed(1)} 小时 ≥ ${OUTAGE_SILENCE_HOURS} 小时`,
      evidenceTime: lastComm,
    }
  }
  if (silenceHours >= WEAK_SILENCE_HOURS) {
    return {
      conclusion: COMM_WEAK,
      evidence: `已静默 ${silenceHours.toFixed(1)} 小时 ≥ ${WEAK_SILENCE_HOURS} 小时`,
      evidenceTime: lastComm,
    }
  }
  const dbm = parseSignalDbm(row['信号强度'])
  if (dbm !== null && dbm <= WEAK_SIGNAL_DBM) {
    return {
      conclusion: COMM_WEAK,
      evidence: `信号强度 ${dbm}dBm ≤ ${WEAK_SIGNAL_DBM}dBm`,
      evidenceTime: lastComm,
    }
  }
  return {
    conclusion: COMM_NORMAL,
    evidence: `${WEAK_SILENCE_HOURS} 小时内有通讯且信号正常`,
    evidenceTime: lastComm,
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function findOpenTicket(tickets: EntryRow[], deviceCode: string): EntryRow | undefined {
  return tickets.find(
    (ticket) => String(ticket['设备编号']) === deviceCode && String(ticket.status) !== '已恢复',
  )
}

export function findOpenStationTodo(todos: EntryRow[], stationCode: string): EntryRow | undefined {
  return todos.find(
    (todo) =>
      String(todo['站点编号']) === stationCode &&
      String(todo['维护类型']) === STATION_TODO_TYPE &&
      !['已完成', '已验收'].includes(String(todo.status)),
  )
}

// 确认中断后同步建单：通讯故障单 + 站房巡检待办。
// 同一设备已有未办结故障单、或同一站点已有通讯巡检待办时不再重复建单（重复回放幂等）。
export function ensureInterruptionTickets(
  state: CommState,
  device: EntryRow,
  now: number,
): { state: CommState; events: string[] } {
  const events: string[] = []
  let { tickets, stationTodos } = state
  const deviceCode = String(device['设备编号'])
  const stationCode = String(device['所属站点'])

  if (!findOpenTicket(tickets, deviceCode)) {
    const id = nextId(tickets)
    tickets = [
      ...tickets,
      {
        id,
        status: '待处置',
        pending: true,
        abnormal: true,
        工单编号: `CFAULT-${String(id).padStart(4, '0')}`,
        设备编号: deviceCode,
        所属站点: stationCode,
        故障类型: FAULT_TICKET_TYPE,
        登记时刻: formatDateTime(now),
        处置人: String(device['维护人员'] ?? ''),
        办结时刻: '',
        工单状态: '待处置',
      },
    ]
    events.push(`已同步生成通讯故障单（设备 ${deviceCode}）`)
  } else {
    events.push(`设备 ${deviceCode} 已有未办结通讯故障单，重复回放不再建单`)
  }

  if (!findOpenStationTodo(stationTodos, stationCode)) {
    const id = nextId(stationTodos)
    stationTodos = [
      ...stationTodos,
      {
        id,
        status: '待安排',
        pending: true,
        abnormal: false,
        记录编号: `STAT-${String(id).padStart(4, '0')}`,
        站点编号: stationCode,
        维护类型: STATION_TODO_TYPE,
        维护内容: `通讯设备 ${deviceCode} 通讯中断，现场核查站房通讯链路`,
        维护单位: '',
        维护日期: formatDate(now),
        费用支出: 0,
        维护状态: '待安排',
      },
    ]
    events.push(`已同步生成站房巡检待办（站点 ${stationCode}）`)
  } else {
    events.push(`站点 ${stationCode} 已有通讯巡检待办，不重复生成`)
  }

  return { state: { ...state, tickets, stationTodos }, events }
}

function replaceDevice(devices: EntryRow[], updated: EntryRow): EntryRow[] {
  return devices.map((row) => (Number(row.id) === Number(updated.id) ? updated : row))
}

// 人工处置动作：单向逐级流转，跳级一律拒绝。
export function manualTransition(
  state: CommState,
  deviceId: number,
  action: string,
  now: number,
): CommTransition {
  const device = state.devices.find((row) => Number(row.id) === deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的通讯设备`, state, events: [] }
  }
  const status = String(device.status)
  const reject = (message: string): CommTransition => ({ ok: false, message, state, events: [] })

  if (status === COMM_DECOMMISSIONED) {
    return reject(`设备已停用，不能执行「${action}」；停用设备不得被判为通讯正常`)
  }

  let target: string
  switch (action) {
    case '登记故障': {
      // 只有通讯正常或信号弱可登记故障，沿单向流程推进一步
      if (status === COMM_NORMAL) {
        target = COMM_WEAK
      } else if (status === COMM_WEAK) {
        target = COMM_OUTAGE
      } else {
        return reject(`只有通讯正常或信号弱的设备才能登记故障，当前状态「${status}」`)
      }
      break
    }
    case '申请更换': {
      if (status !== COMM_OUTAGE) {
        return reject(`只有通讯中断的设备才能申请更换，从「${status}」跳到「待更换」属于跳级，已拒绝`)
      }
      target = COMM_PENDING_REPLACE
      break
    }
    case '确认恢复': {
      // 更换完成后才能恢复：只允许 待更换 → 通讯正常
      if (status !== COMM_PENDING_REPLACE) {
        return reject(`更换完成后才能恢复，当前状态「${status}」不能确认恢复，跳级操作已拒绝`)
      }
      target = COMM_NORMAL
      break
    }
    case '停用设备': {
      target = COMM_DECOMMISSIONED
      break
    }
    default:
      return reject(`通讯设备没有登记「${action}」这个动作`)
  }

  const updated: EntryRow = {
    ...device,
    status: target,
    pending: target !== COMM_NORMAL && target !== COMM_DECOMMISSIONED,
    abnormal: target !== COMM_NORMAL && target !== COMM_DECOMMISSIONED,
  }
  // 人工抢修（确认恢复）留下人工结论时刻，供自动研判冲突仲裁；其余动作清除过期人工结论
  if (action === '确认恢复') {
    updated['人工结论'] = COMM_NORMAL
    updated['人工结论时刻'] = formatDateTime(now)
  } else {
    delete updated['人工结论']
    delete updated['人工结论时刻']
  }

  let next: CommState = { ...state, devices: replaceDevice(state.devices, updated) }
  const events: string[] = []

  if (target === COMM_OUTAGE) {
    // 确认中断后：通讯故障单与站房巡检待办同步生成
    const synced = ensureInterruptionTickets(next, updated, now)
    next = synced.state
    events.push(...synced.events)
  }

  if (action === '确认恢复') {
    // 恢复后同步办结该设备的未办结故障单
    const deviceCode = String(updated['设备编号'])
    const open = findOpenTicket(next.tickets, deviceCode)
    if (open) {
      next = {
        ...next,
        tickets: next.tickets.map((ticket) =>
          Number(ticket.id) === Number(open.id)
            ? {
                ...ticket,
                status: '已恢复',
                pending: false,
                abnormal: false,
                办结时刻: formatDateTime(now),
                工单状态: '已恢复',
              }
            : ticket,
        ),
      }
      events.push(`通讯故障单 ${String(open['工单编号'])} 已同步办结`)
    }
  }

  return { ok: true, message: `通讯设备已${action}，当前状态「${target}」`, state: next, events }
}

// 自动质量研判：逐台给出结论，只沿单向流程向前推进，绝不自动回退；
// 与人工抢修结论冲突时人工优先。
export function autoEvaluate(
  state: CommState,
  now: number,
): { state: CommState; items: AutoEvalItem[]; events: string[] } {
  let current: CommState = {
    devices: [...state.devices],
    tickets: [...state.tickets],
    stationTodos: [...state.stationTodos],
  }
  const items: AutoEvalItem[] = []
  const events: string[] = []

  for (const device of state.devices) {
    const deviceId = Number(device.id)
    const deviceCode = String(device['设备编号'])

    // 历史设备缺少最近通讯时刻，按安装日期回填
    const { row, backfilled } = backfillLastComm(device)
    if (backfilled) {
      current = { ...current, devices: replaceDevice(current.devices, row) }
      events.push(`设备 ${deviceCode} 缺少最近通讯时刻，已按安装日期 ${String(row['安装日期'])} 回填`)
    }

    const status = String(row.status)
    const { conclusion, evidence, evidenceTime } = autoConclusionOf(row, now)
    const item = (applied: boolean, note: string): AutoEvalItem => ({
      deviceId,
      deviceCode,
      from: status,
      conclusion,
      applied,
      note,
    })

    if (status === COMM_DECOMMISSIONED) {
      items.push(item(false, '停用设备不参与研判，不得被判为通讯正常'))
      continue
    }
    if (status === COMM_PENDING_REPLACE) {
      items.push(item(false, '待更换设备等待更换，自动研判不改动'))
      continue
    }

    const fromIndex = COMM_FLOW.indexOf(status as (typeof COMM_FLOW)[number])
    const toIndex = COMM_FLOW.indexOf(conclusion as (typeof COMM_FLOW)[number])
    if (toIndex <= fromIndex) {
      // 已处于通讯中断：补齐故障单与巡检待办（幂等，重复回放不重复建单）
      if (status === COMM_OUTAGE) {
        const synced = ensureInterruptionTickets(current, row, now)
        current = synced.state
        events.push(...synced.events.filter((event) => event.startsWith('已同步生成')))
      }
      const note =
        toIndex < fromIndex
          ? '自动结论好转，但单向流程不自动回退，须走更换完成后的确认恢复'
          : evidenceTime === null
            ? evidence
            : '状态与自动结论一致'
      items.push(item(false, note))
      continue
    }

    // 人工抢修与自动质量结论冲突：人工结论优先（自动证据早于人工结论时刻）
    const manualAt = parseTimeValue(row['人工结论时刻'])
    if (manualAt !== null && evidenceTime !== null && evidenceTime < manualAt) {
      items.push(
        item(false, `人工抢修结论优先：自动依据（${evidence}）早于人工确认时刻，维持「${status}」`),
      )
      events.push(`设备 ${deviceCode} 自动研判「${conclusion}」与人工抢修结论冲突，按人工优先维持「${status}」`)
      continue
    }

    const updated: EntryRow = { ...row, status: conclusion, pending: true, abnormal: true }
    delete updated['人工结论']
    delete updated['人工结论时刻']
    current = { ...current, devices: replaceDevice(current.devices, updated) }
    items.push(item(true, evidence))
    events.push(`设备 ${deviceCode} 自动研判：${status} → ${conclusion}（${evidence}）`)

    if (conclusion === COMM_OUTAGE) {
      const synced = ensureInterruptionTickets(current, updated, now)
      current = synced.state
      events.push(...synced.events)
    }
  }

  return { state: current, items, events }
}
