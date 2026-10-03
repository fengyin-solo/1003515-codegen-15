import { beforeEach, describe, expect, it } from 'vitest'

import {
  listCommunicationEntries,
  runAutoEvaluation,
  runCommunicationAction,
} from '@/api/communication-service'
import { runAction } from '@/api/local-service'
import { listRows, resetRows } from '@/data/local-store'

// 服务层端到端：走真实 local-store（node 环境无 localStorage，落在内存缓存 + 种子数据上）。
beforeEach(() => {
  resetRows('communication')
  resetRows('commfault')
  resetRows('stationhouse')
})

describe('通讯域服务（持久化联通）', () => {
  it('打开列表时历史设备缺少最近通讯时刻按安装日期回填', () => {
    const page = listCommunicationEntries()
    const legacy = page.items.find((row) => row['设备编号'] === 'COMM-0004')
    expect(legacy?.['最近通讯时刻']).toBe('2021-06-15')
  })

  it('登记故障逐级推进，确认中断后故障单与站房巡检待办同步落库', () => {
    const first = runCommunicationAction(1, '登记故障')
    expect(first.ok).toBe(true)
    expect(listRows('communication').find((row) => row.id === 1)?.status).toBe('信号弱')
    expect(listRows('commfault')).toHaveLength(0)

    const second = runCommunicationAction(1, '登记故障')
    expect(second.ok).toBe(true)
    expect(listRows('communication').find((row) => row.id === 1)?.status).toBe('通讯中断')

    const tickets = listRows('commfault')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]['设备编号']).toBe('COMM-0001')
    expect(tickets[0].status).toBe('待处置')

    const todos = listRows('stationhouse').filter((row) => row['维护类型'] === '通讯巡检')
    expect(todos).toHaveLength(1)
    expect(todos[0]['站点编号']).toBe('STAT-0001')
    expect(todos[0].status).toBe('待安排')
  })

  it('跳级动作被拒绝且不写库', () => {
    const result = runCommunicationAction(1, '申请更换')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('跳级')
    expect(listRows('communication').find((row) => row.id === 1)?.status).toBe('通讯正常')
  })

  it('通用入口 runAction 同样走单向流程状态机', () => {
    const rejected = runAction('communication', 1, '确认恢复')
    expect(rejected.ok).toBe(false)
    expect(rejected.message).toContain('更换完成后才能恢复')
  })

  it('自动研判：历史设备回填后判中断建单，停用设备不判正常，重复运行不重复建单', () => {
    const first = runAutoEvaluation()
    const devices = listRows('communication')

    // COMM-0004：回填安装日期后静默多年 → 通讯中断并建单
    expect(devices.find((row) => row['设备编号'] === 'COMM-0004')?.status).toBe('通讯中断')
    // COMM-0005：已停用，即使最近通讯时刻新鲜也不得判为正常
    expect(devices.find((row) => row['设备编号'] === 'COMM-0005')?.status).toBe('已停用')
    // COMM-0003 种子里已是通讯中断 → 自动补齐故障单
    const tickets = listRows('commfault')
    expect(tickets.map((row) => row['设备编号']).sort()).toEqual(['COMM-0003', 'COMM-0004'])
    expect(first.events.join('')).toContain('回填')

    const second = runAutoEvaluation()
    expect(listRows('commfault')).toHaveLength(2)
    expect(listRows('stationhouse').filter((row) => row['维护类型'] === '通讯巡检')).toHaveLength(2)
    expect(second.message).toContain('自动研判完成')
  })

  it('人工抢修结论优先：更换恢复后自动研判不立即打回', () => {
    // 自动研判先为种子里的中断设备 COMM-0003 补齐故障单
    runAutoEvaluation()
    expect(listRows('commfault').find((row) => row['设备编号'] === 'COMM-0003')?.status).toBe('待处置')

    // COMM-0003 通讯中断 → 申请更换 → 确认恢复（人工抢修完成）
    expect(runCommunicationAction(3, '申请更换').ok).toBe(true)
    expect(runCommunicationAction(3, '确认恢复').ok).toBe(true)
    expect(listRows('communication').find((row) => row.id === 3)?.status).toBe('通讯正常')
    // 恢复后旧故障单已办结
    const closed = listRows('commfault').find((row) => row['设备编号'] === 'COMM-0003')
    expect(closed?.status).toBe('已恢复')
    expect(closed?.['办结时刻']).not.toBe('')

    // 最近通讯时刻仍是陈旧值，自动结论想说通讯中断，但人工抢修结论优先
    const result = runAutoEvaluation()
    expect(listRows('communication').find((row) => row.id === 3)?.status).toBe('通讯正常')
    const item = result.items.find((entry) => entry.deviceCode === 'COMM-0003')
    expect(item?.applied).toBe(false)
    expect(item?.note).toContain('人工抢修结论优先')
    // 不重复建单
    expect(listRows('commfault').filter((row) => row['设备编号'] === 'COMM-0003')).toHaveLength(1)
  })
})
