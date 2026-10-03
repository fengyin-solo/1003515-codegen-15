import { describe, expect, it } from 'vitest'

import type { EntryRow } from '@/data/types'
import {
  autoEvaluate,
  backfillLastComm,
  COMM_DECOMMISSIONED,
  COMM_NORMAL,
  COMM_OUTAGE,
  COMM_PENDING_REPLACE,
  COMM_WEAK,
  ensureInterruptionTickets,
  findOpenTicket,
  formatDateTime,
  manualTransition,
  parseSignalDbm,
  parseTimeValue,
  type CommState,
} from '@/domain/communication'

// 固定的研判基准时刻：2026-10-03 12:00（本地时间）
const NOW = new Date(2026, 9, 3, 12, 0, 0).getTime()
const HOUR = 3_600_000

function device(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    status: COMM_NORMAL,
    pending: false,
    abnormal: false,
    设备编号: 'COMM-0001',
    设备类型: '卫星终端',
    所属站点: 'STAT-0001',
    通讯协议: '北斗短报文',
    安装日期: '2024-05-12',
    信号强度: '-68dBm',
    最近通讯时刻: '2026-10-03 11:30',
    维护人员: '张工',
    设备状态: '通讯正常',
    ...overrides,
  }
}

function stateWith(
  devices: EntryRow[],
  tickets: EntryRow[] = [],
  stationTodos: EntryRow[] = [],
): CommState {
  return { devices, tickets, stationTodos }
}

describe('单向处置流程：人工动作逐级流转', () => {
  it('登记故障沿流程逐级推进：通讯正常 → 信号弱 → 通讯中断', () => {
    const state = stateWith([device()])
    const first = manualTransition(state, 1, '登记故障', NOW)
    expect(first.ok).toBe(true)
    expect(first.state.devices[0].status).toBe(COMM_WEAK)

    const second = manualTransition(first.state, 1, '登记故障', NOW)
    expect(second.ok).toBe(true)
    expect(second.state.devices[0].status).toBe(COMM_OUTAGE)
  })

  it('只有通讯正常或信号弱可登记故障，通讯中断与待更换被拒绝', () => {
    for (const status of [COMM_OUTAGE, COMM_PENDING_REPLACE]) {
      const result = manualTransition(stateWith([device({ status })]), 1, '登记故障', NOW)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('只有通讯正常或信号弱')
      expect(result.state.devices[0].status).toBe(status)
    }
  })

  it('申请更换只允许通讯中断，正常/弱信号跳级必须拒绝', () => {
    for (const status of [COMM_NORMAL, COMM_WEAK]) {
      const result = manualTransition(stateWith([device({ status })]), 1, '申请更换', NOW)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('跳级')
      expect(result.state.devices[0].status).toBe(status)
    }
    const ok = manualTransition(stateWith([device({ status: COMM_OUTAGE })]), 1, '申请更换', NOW)
    expect(ok.ok).toBe(true)
    expect(ok.state.devices[0].status).toBe(COMM_PENDING_REPLACE)
  })

  it('更换完成后才能恢复：确认恢复只允许待更换，其余状态跳级拒绝', () => {
    for (const status of [COMM_NORMAL, COMM_WEAK, COMM_OUTAGE]) {
      const result = manualTransition(stateWith([device({ status })]), 1, '确认恢复', NOW)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('更换完成后才能恢复')
      expect(result.state.devices[0].status).toBe(status)
    }
    const ok = manualTransition(
      stateWith([device({ status: COMM_PENDING_REPLACE })]),
      1,
      '确认恢复',
      NOW,
    )
    expect(ok.ok).toBe(true)
    expect(ok.state.devices[0].status).toBe(COMM_NORMAL)
  })

  it('停用设备为终态：一切处置动作都被拒绝', () => {
    const decommissioned = manualTransition(stateWith([device({ status: COMM_WEAK })]), 1, '停用设备', NOW)
    expect(decommissioned.ok).toBe(true)
    expect(decommissioned.state.devices[0].status).toBe(COMM_DECOMMISSIONED)

    for (const action of ['登记故障', '申请更换', '确认恢复', '停用设备']) {
      const result = manualTransition(decommissioned.state, 1, action, NOW)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('已停用')
      expect(result.state.devices[0].status).toBe(COMM_DECOMMISSIONED)
    }
  })

  it('未登记的动作直接拒绝', () => {
    const result = manualTransition(stateWith([device()]), 1, '远程重启', NOW)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有登记')
  })
})

describe('确认中断后同步建单', () => {
  it('登记故障进入通讯中断时，通讯故障单与站房巡检待办同步生成', () => {
    const state = stateWith([device({ status: COMM_WEAK })])
    const result = manualTransition(state, 1, '登记故障', NOW)
    expect(result.ok).toBe(true)
    expect(result.state.devices[0].status).toBe(COMM_OUTAGE)

    expect(result.state.tickets).toHaveLength(1)
    const ticket = result.state.tickets[0]
    expect(ticket.status).toBe('待处置')
    expect(ticket['设备编号']).toBe('COMM-0001')
    expect(ticket['故障类型']).toBe('通讯中断')
    expect(ticket['登记时刻']).toBe(formatDateTime(NOW))

    expect(result.state.stationTodos).toHaveLength(1)
    const todo = result.state.stationTodos[0]
    expect(todo.status).toBe('待安排')
    expect(todo['维护类型']).toBe('通讯巡检')
    expect(todo['站点编号']).toBe('STAT-0001')
  })

  it('重复回放同一设备不重复建单', () => {
    const interrupted = device({ status: COMM_OUTAGE })
    const first = ensureInterruptionTickets(stateWith([interrupted]), interrupted, NOW)
    expect(first.state.tickets).toHaveLength(1)
    expect(first.state.stationTodos).toHaveLength(1)

    // 同一设备再次回放：已有未办结故障单，不再建单
    const second = ensureInterruptionTickets(first.state, interrupted, NOW + HOUR)
    expect(second.state.tickets).toHaveLength(1)
    expect(second.state.stationTodos).toHaveLength(1)
    expect(second.events.join('')).toContain('重复回放不再建单')
  })

  it('确认恢复后故障单同步办结；再次中断时按新 episode 开新单', () => {
    let state = stateWith([device({ status: COMM_WEAK })])
    state = manualTransition(state, 1, '登记故障', NOW).state
    expect(state.tickets).toHaveLength(1)

    state = manualTransition(state, 1, '申请更换', NOW + HOUR).state
    const recovered = manualTransition(state, 1, '确认恢复', NOW + 2 * HOUR)
    expect(recovered.ok).toBe(true)
    expect(recovered.state.tickets).toHaveLength(1)
    expect(recovered.state.tickets[0].status).toBe('已恢复')
    expect(recovered.state.tickets[0]['办结时刻']).toBe(formatDateTime(NOW + 2 * HOUR))
    expect(findOpenTicket(recovered.state.tickets, 'COMM-0001')).toBeUndefined()

    // 恢复后再次中断：旧单已办结，必须开新单
    const again = manualTransition(recovered.state, 1, '登记故障', NOW + 3 * HOUR)
    const interruptedAgain = manualTransition(again.state, 1, '登记故障', NOW + 4 * HOUR)
    expect(interruptedAgain.state.tickets).toHaveLength(2)
    const open = findOpenTicket(interruptedAgain.state.tickets, 'COMM-0001')
    expect(open).toBeDefined()
    expect(open?.status).toBe('待处置')
  })
})

describe('自动质量研判', () => {
  it('静默 6 小时判信号弱，24 小时判通讯中断，信号 ≤ -100dBm 判信号弱', () => {
    const weak = device({ id: 1, 设备编号: 'COMM-0001', 最近通讯时刻: '2026-10-03 04:00' }) // 静默 8 小时
    const outage = device({ id: 2, 设备编号: 'COMM-0002', 最近通讯时刻: '2026-10-02 10:00' }) // 静默 26 小时
    const weakSignal = device({ id: 3, 设备编号: 'COMM-0003', 信号强度: '-105dBm' })
    const healthy = device({ id: 4, 设备编号: 'COMM-0004' })

    const { state, items } = autoEvaluate(stateWith([weak, outage, weakSignal, healthy]), NOW)
    const byId = new Map(items.map((item) => [item.deviceId, item]))

    expect(byId.get(1)?.conclusion).toBe(COMM_WEAK)
    expect(byId.get(1)?.applied).toBe(true)
    expect(byId.get(2)?.conclusion).toBe(COMM_OUTAGE)
    expect(byId.get(2)?.applied).toBe(true)
    expect(byId.get(3)?.conclusion).toBe(COMM_WEAK)
    expect(byId.get(3)?.applied).toBe(true)
    expect(byId.get(4)?.conclusion).toBe(COMM_NORMAL)
    expect(byId.get(4)?.applied).toBe(false)

    expect(state.devices.find((row) => row.id === 2)?.status).toBe(COMM_OUTAGE)
    // 自动研判确认中断同样同步建单
    expect(state.tickets).toHaveLength(1)
    expect(state.tickets[0]['设备编号']).toBe('COMM-0002')
    expect(state.stationTodos).toHaveLength(1)
  })

  it('只沿单向流程前进，绝不自动回退', () => {
    // 信号弱设备信号恢复，自动结论好转，但状态不回退
    const weakDevice = device({ status: COMM_WEAK, 最近通讯时刻: '2026-10-03 11:30' })
    const { state, items } = autoEvaluate(stateWith([weakDevice]), NOW)
    expect(items[0].conclusion).toBe(COMM_NORMAL)
    expect(items[0].applied).toBe(false)
    expect(items[0].note).toContain('不自动回退')
    expect(state.devices[0].status).toBe(COMM_WEAK)
  })

  it('停用设备不得被判为正常：即使通讯证据新鲜也保持已停用', () => {
    const decommissioned = device({
      status: COMM_DECOMMISSIONED,
      最近通讯时刻: '2026-10-03 11:55',
      信号强度: '-60dBm',
    })
    const { state, items } = autoEvaluate(stateWith([decommissioned]), NOW)
    expect(items[0].conclusion).not.toBe(COMM_NORMAL)
    expect(items[0].applied).toBe(false)
    expect(state.devices[0].status).toBe(COMM_DECOMMISSIONED)
  })

  it('待更换设备等待更换，自动研判不改动', () => {
    const pending = device({ status: COMM_PENDING_REPLACE, 最近通讯时刻: '2026-09-01 00:00' })
    const { state, items } = autoEvaluate(stateWith([pending]), NOW)
    expect(items[0].applied).toBe(false)
    expect(state.devices[0].status).toBe(COMM_PENDING_REPLACE)
  })

  it('重复回放同一设备不重复建单（自动研判幂等）', () => {
    const silent = device({ 最近通讯时刻: '2026-10-01 00:00' })
    const first = autoEvaluate(stateWith([silent]), NOW)
    expect(first.state.tickets).toHaveLength(1)
    expect(first.state.stationTodos).toHaveLength(1)

    const second = autoEvaluate(first.state, NOW + HOUR)
    expect(second.state.tickets).toHaveLength(1)
    expect(second.state.stationTodos).toHaveLength(1)
  })

  it('已处于通讯中断的设备自动研判时补齐故障单与巡检待办（幂等）', () => {
    const interrupted = device({ status: COMM_OUTAGE, 最近通讯时刻: '2026-10-01 00:00' })
    const first = autoEvaluate(stateWith([interrupted]), NOW)
    expect(first.state.tickets).toHaveLength(1)
    expect(first.state.stationTodos).toHaveLength(1)

    const second = autoEvaluate(first.state, NOW + HOUR)
    expect(second.state.tickets).toHaveLength(1)
    expect(second.state.stationTodos).toHaveLength(1)
  })
})

describe('人工抢修与自动质量结论冲突：人工优先', () => {
  it('确认恢复后自动证据仍陈旧时，维持人工结论并记录冲突', () => {
    // 设备更换完成，人工确认恢复；但最近通讯时刻仍是旧值，自动结论会说通讯中断
    const recovered = device({
      status: COMM_PENDING_REPLACE,
      最近通讯时刻: '2026-09-30 08:00',
    })
    let state = stateWith([recovered])
    state = manualTransition(state, 1, '确认恢复', NOW).state
    expect(state.devices[0].status).toBe(COMM_NORMAL)
    expect(state.devices[0]['人工结论时刻']).toBe(formatDateTime(NOW))

    const { state: evaluated, items, events } = autoEvaluate(state, NOW + 2 * HOUR)
    expect(items[0].conclusion).toBe(COMM_OUTAGE)
    expect(items[0].applied).toBe(false)
    expect(items[0].note).toContain('人工抢修结论优先')
    expect(events.join('')).toContain('人工优先')
    expect(evaluated.devices[0].status).toBe(COMM_NORMAL)
    expect(evaluated.tickets).toHaveLength(0)
  })

  it('出现比人工结论更新的通讯证据后，自动研判恢复生效', () => {
    const recovered = device({
      status: COMM_NORMAL,
      人工结论: COMM_NORMAL,
      人工结论时刻: '2026-10-03 12:00',
      最近通讯时刻: '2026-10-03 13:00', // 比人工结论新
    })
    // 研判时刻 2026-10-04 14:00：距最近通讯 25 小时，证据新于人工结论，自动结论生效
    const later = new Date(2026, 9, 4, 14, 0, 0).getTime()
    const { state, items } = autoEvaluate(stateWith([recovered]), later)
    expect(items[0].conclusion).toBe(COMM_OUTAGE)
    expect(items[0].applied).toBe(true)
    expect(state.devices[0].status).toBe(COMM_OUTAGE)
    expect(state.devices[0]['人工结论时刻']).toBeUndefined()
  })
})

describe('历史设备最近通讯时刻回填', () => {
  it('缺少最近通讯时刻按安装日期回填', () => {
    const legacy = device({ 最近通讯时刻: '', 安装日期: '2021-06-15' })
    const { row, backfilled } = backfillLastComm(legacy)
    expect(backfilled).toBe(true)
    expect(row['最近通讯时刻']).toBe('2021-06-15')
  })

  it('已有最近通讯时刻不回填；安装日期也缺失时无法回填', () => {
    const fresh = device({ 最近通讯时刻: '2026-10-03 10:00' })
    expect(backfillLastComm(fresh).backfilled).toBe(false)

    const noEvidence = device({ 最近通讯时刻: '', 安装日期: '' })
    expect(backfillLastComm(noEvidence).backfilled).toBe(false)
  })

  it('自动研判时历史设备先回填再下结论，回填后按安装日期判中断并建单', () => {
    const legacy = device({ 最近通讯时刻: '', 安装日期: '2021-06-15' })
    const { state, items, events } = autoEvaluate(stateWith([legacy]), NOW)
    expect(events.join('')).toContain('按安装日期 2021-06-15 回填')
    expect(state.devices[0]['最近通讯时刻']).toBe('2021-06-15')
    expect(items[0].conclusion).toBe(COMM_OUTAGE)
    expect(items[0].applied).toBe(true)
    expect(state.tickets).toHaveLength(1)
  })

  it('最近通讯时刻与安装日期都缺失时证据不足，维持原状态', () => {
    const blank = device({ 最近通讯时刻: '', 安装日期: '' })
    const { state, items } = autoEvaluate(stateWith([blank]), NOW)
    expect(items[0].applied).toBe(false)
    expect(items[0].note).toContain('证据不足')
    expect(state.devices[0].status).toBe(COMM_NORMAL)
  })
})

describe('时间、信号解析与回填辅助函数', () => {
  it('parseTimeValue 支持日期与日期时间两种格式', () => {
    expect(parseTimeValue('2026-10-03')).toBe(new Date(2026, 9, 3, 0, 0, 0).getTime())
    expect(parseTimeValue('2026-10-03 08:30')).toBe(new Date(2026, 9, 3, 8, 30, 0).getTime())
    expect(parseTimeValue('')).toBeNull()
    expect(parseTimeValue('通讯系统样例1')).toBeNull()
    expect(parseTimeValue(undefined)).toBeNull()
  })

  it('parseSignalDbm 只接受 dBm 描述或纯数字', () => {
    expect(parseSignalDbm('-105dBm')).toBe(-105)
    expect(parseSignalDbm(-98)).toBe(-98)
    expect(parseSignalDbm('无信号')).toBeNull()
    expect(parseSignalDbm('通讯系统样例1')).toBeNull()
  })
})
