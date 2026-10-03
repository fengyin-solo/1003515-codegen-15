// 通讯设备单向处置流程的规则验证。运行方式见 package.json 的 test 脚本：
// 用 esbuild 把本文件与 src 打包成 node 脚本执行，不引入额外测试框架。
import assert from 'node:assert/strict'

import {
  applyCommunicationAction,
  backfillCommRows,
  COMM_KEY,
  FAULT_KEY,
  STATIONHOUSE_KEY,
} from '../src/api/communication-flow'
import { listEntries, runAction } from '../src/api/local-service'
import { listRows, resetRows, saveRows } from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'

function fmt(time: number): string {
  const d = new Date(time)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const HOUR = 60 * 60 * 1000

function device(id: number, status: string, extra: Record<string, string> = {}): EntryRow {
  return {
    id,
    status,
    pending: status !== '通讯正常' && status !== '已停用',
    abnormal: status !== '通讯正常',
    设备编号: `COMM-T${id}`,
    设备类型: '测试终端',
    所属站点: 'STAT-T1',
    通讯协议: '4G',
    信号强度: '80',
    安装日期: '2026-01-01',
    最近通讯时刻: fmt(Date.now() - 1 * HOUR),
    维护人员: '测试班',
    设备状态: status,
    ...extra,
  }
}

function resetAll(): void {
  resetRows(COMM_KEY)
  resetRows(FAULT_KEY)
  resetRows(STATIONHOUSE_KEY)
}

function commRow(id: number): EntryRow {
  const row = listRows(COMM_KEY).find((item) => Number(item.id) === id)
  assert.ok(row, `设备 ${id} 应存在`)
  return row
}

function ticketsFor(code: string): EntryRow[] {
  return listRows(FAULT_KEY).filter((row) => String(row['设备编号']) === code)
}

function todosFor(code: string): EntryRow[] {
  return listRows(STATIONHOUSE_KEY).filter(
    (row) => String(row['维护类型']) === '站房巡检' && String(row['维护内容']).includes(code),
  )
}

let passed = 0
function test(name: string, fn: () => void): void {
  resetAll()
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

// 1. 历史设备缺少最近通讯时刻，按安装日期回填
test('历史设备缺少最近通讯时刻按安装日期回填', () => {
  saveRows(COMM_KEY, [device(1, '通讯中断', { 最近通讯时刻: '', 安装日期: '2026-01-15' })])
  assert.equal(backfillCommRows(), true)
  assert.equal(commRow(1)['最近通讯时刻'], '2026-01-15')
  // 列表读取同样触发回填
  saveRows(COMM_KEY, [device(1, '通讯中断', { 最近通讯时刻: '', 安装日期: '2026-02-20' })])
  listEntries(COMM_KEY)
  assert.equal(commRow(1)['最近通讯时刻'], '2026-02-20')
})

// 2. 单向处置流程 happy path：正常 → 中断 → 待更换 → 恢复
test('单向流程：登记故障 → 申请更换 → 人工抢修恢复', () => {
  saveRows(COMM_KEY, [device(1, '通讯正常')])
  let result = runAction(COMM_KEY, 1, '登记故障')
  assert.equal(result.ok, true)
  assert.equal(commRow(1).status, '通讯中断')
  result = runAction(COMM_KEY, 1, '申请更换')
  assert.equal(result.ok, true)
  assert.equal(commRow(1).status, '待更换')
  result = runAction(COMM_KEY, 1, '人工抢修')
  assert.equal(result.ok, true)
  assert.equal(commRow(1).status, '通讯正常')
})

// 3. 弱信号同样可以登记故障
test('信号弱可登记故障', () => {
  saveRows(COMM_KEY, [device(1, '信号弱')])
  const result = runAction(COMM_KEY, 1, '登记故障')
  assert.equal(result.ok, true)
  assert.equal(commRow(1).status, '通讯中断')
})

// 4. 跳级状态必须拒绝
test('跳级状态一律拒绝', () => {
  saveRows(COMM_KEY, [
    device(1, '通讯正常'),
    device(2, '信号弱'),
    device(3, '通讯中断'),
    device(4, '待更换'),
  ])
  // 正常/弱不能直接申请更换
  assert.equal(runAction(COMM_KEY, 1, '申请更换').ok, false)
  assert.equal(runAction(COMM_KEY, 2, '申请更换').ok, false)
  // 正常/弱/中断不能登记故障以外的恢复，中断不能重复登记故障
  assert.equal(runAction(COMM_KEY, 3, '登记故障').ok, false)
  assert.equal(runAction(COMM_KEY, 4, '登记故障').ok, false)
  // 中断不能跳级恢复，必须先更换
  assert.equal(runAction(COMM_KEY, 3, '人工抢修').ok, false)
  // 待更换不能回到申请更换
  assert.equal(runAction(COMM_KEY, 4, '申请更换').ok, false)
  // 状态都保持原样
  assert.equal(commRow(1).status, '通讯正常')
  assert.equal(commRow(2).status, '信号弱')
  assert.equal(commRow(3).status, '通讯中断')
  assert.equal(commRow(4).status, '待更换')
})

// 5. 确认中断后同步生成通讯故障单和站房巡检待办
test('确认中断同步生成故障单与站房巡检待办', () => {
  saveRows(COMM_KEY, [device(1, '通讯正常')])
  const result = runAction(COMM_KEY, 1, '登记故障')
  assert.equal(result.ok, true)
  const tickets = ticketsFor('COMM-T1')
  assert.equal(tickets.length, 1)
  assert.equal(tickets[0].status, '待处理')
  assert.equal(tickets[0]['故障类型'], '通讯中断')
  const todos = todosFor('COMM-T1')
  assert.equal(todos.length, 1)
  assert.equal(todos[0].status, '待安排')
})

// 6. 重复回放同一设备不重复建单
test('重复回放同一设备不重复建单', () => {
  saveRows(COMM_KEY, [
    device(1, '通讯正常', { 最近通讯时刻: fmt(Date.now() - 48 * HOUR), 信号强度: '0' }),
  ])
  // 第一次回放：自动判定中断并建单
  let result = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(result.ok, true)
  assert.equal(commRow(1).status, '通讯中断')
  assert.equal(ticketsFor('COMM-T1').length, 1)
  assert.equal(todosFor('COMM-T1').length, 1)
  // 重复回放：仍是中断，不重复建单
  result = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(result.ok, true)
  assert.equal(ticketsFor('COMM-T1').length, 1)
  assert.equal(todosFor('COMM-T1').length, 1)
  // 中断状态不能再登记故障建单
  assert.equal(runAction(COMM_KEY, 1, '登记故障').ok, false)
  assert.equal(ticketsFor('COMM-T1').length, 1)
})

// 7. 停用设备不得被判为正常
test('停用设备不得被判为正常', () => {
  saveRows(COMM_KEY, [
    device(1, '已停用', { 信号强度: '99', 最近通讯时刻: fmt(Date.now()) }),
    device(2, '通讯正常'),
  ])
  // 自动回放：拒绝判定
  const replay = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(replay.ok, false)
  assert.match(replay.message, /不得判为通讯正常/)
  assert.equal(commRow(1).status, '已停用')
  // 人工抢修/登记故障/申请更换：全部拒绝
  assert.equal(runAction(COMM_KEY, 1, '人工抢修').ok, false)
  assert.equal(runAction(COMM_KEY, 1, '登记故障').ok, false)
  assert.equal(runAction(COMM_KEY, 1, '申请更换').ok, false)
  assert.equal(commRow(1).status, '已停用')
  // 正常设备可以停用，停用是终态
  assert.equal(runAction(COMM_KEY, 2, '停用设备').ok, true)
  assert.equal(commRow(2).status, '已停用')
  assert.equal(runAction(COMM_KEY, 2, '自动回放').ok, false)
})

// 8. 人工抢修与自动质量结论冲突时人工优先
test('人工抢修结论与自动质量结论冲突时人工优先', () => {
  saveRows(COMM_KEY, [device(1, '待更换')])
  // 人工抢修确认恢复，写入人工结论
  assert.equal(runAction(COMM_KEY, 1, '人工抢修').ok, true)
  assert.equal(commRow(1).status, '通讯正常')
  // 模拟设备再次失联：自动回放得出「通讯中断」，与人工结论冲突
  saveRows(COMM_KEY, [
    { ...commRow(1), 最近通讯时刻: fmt(Date.now() - 72 * HOUR), 信号强度: '0' },
  ])
  const replay = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(replay.ok, true)
  assert.match(replay.message, /人工优先/)
  assert.equal(commRow(1).status, '通讯正常')
  // 值班员认可自动结论，重新登记故障：进入新回合，人工结论失效
  assert.equal(runAction(COMM_KEY, 1, '登记故障').ok, true)
  assert.equal(commRow(1).status, '通讯中断')
  const again = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(again.ok, true)
  assert.equal(commRow(1).status, '通讯中断')
})

// 9. 人工抢修恢复后，同设备未办结故障单同步办结
test('恢复后同设备故障单同步办结', () => {
  saveRows(COMM_KEY, [device(1, '通讯正常')])
  assert.equal(runAction(COMM_KEY, 1, '登记故障').ok, true)
  assert.equal(runAction(COMM_KEY, 1, '申请更换').ok, true)
  assert.equal(ticketsFor('COMM-T1')[0].status, '待处理')
  assert.equal(runAction(COMM_KEY, 1, '人工抢修').ok, true)
  assert.equal(commRow(1).status, '通讯正常')
  assert.equal(ticketsFor('COMM-T1')[0].status, '已恢复')
  // 新一轮故障可以重新建单
  assert.equal(runAction(COMM_KEY, 1, '登记故障').ok, true)
  assert.equal(ticketsFor('COMM-T1').length, 2)
})

// 10. 自动质量结论只前进不回退
test('自动回放只前进不回退', () => {
  saveRows(COMM_KEY, [
    device(1, '通讯中断', { 信号强度: '90', 最近通讯时刻: fmt(Date.now()) }),
    device(2, '待更换', { 信号强度: '90', 最近通讯时刻: fmt(Date.now()) }),
    device(3, '通讯正常', { 信号强度: '42' }),
  ])
  // 中断设备信号恢复：自动结论正常，但不能直接恢复
  const first = runAction(COMM_KEY, 1, '自动回放')
  assert.equal(first.ok, true)
  assert.equal(commRow(1).status, '通讯中断')
  // 待更换设备：恢复必须人工抢修确认
  const second = runAction(COMM_KEY, 2, '自动回放')
  assert.equal(second.ok, true)
  assert.equal(commRow(2).status, '待更换')
  // 正常设备信号变弱：前进到信号弱
  const third = runAction(COMM_KEY, 3, '自动回放')
  assert.equal(third.ok, true)
  assert.equal(commRow(3).status, '信号弱')
})

// 11. 通用模块的流转不受通讯状态机影响
test('其他模块仍走通用流转', () => {
  const result = runAction(STATIONHOUSE_KEY, 1, '安排维护')
  assert.equal(result.ok, true)
  assert.equal(listRows(STATIONHOUSE_KEY)[0].status, '已安排')
})

console.log(`\n${passed} 个用例全部通过`)
