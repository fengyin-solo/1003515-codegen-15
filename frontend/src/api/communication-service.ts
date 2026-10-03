import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, PageResult } from '@/data/types'
import {
  autoEvaluate,
  backfillLastComm,
  manualTransition,
  type AutoEvalItem,
  type CommState,
} from '@/domain/communication'

// 通讯域服务：把 src/domain/communication.ts 的纯函数接到本地持久化上。
// 通讯设备、通讯故障单（commfault）、站房巡检待办（stationhouse）三份数据一起读写。

function loadState(): CommState {
  return {
    devices: listRows('communication'),
    tickets: listRows('commfault'),
    stationTodos: listRows('stationhouse'),
  }
}

function saveState(state: CommState): void {
  saveRows('communication', state.devices)
  saveRows('commfault', state.tickets)
  saveRows('stationhouse', state.stationTodos)
}

export type CommActionResult = ActionResult & { events: string[] }

export function runCommunicationAction(id: number, action: string): CommActionResult {
  const result = manualTransition(loadState(), id, action, Date.now())
  if (!result.ok) {
    return { ok: false, message: result.message, events: [] }
  }
  saveState(result.state)
  return { ok: true, message: result.message, events: result.events }
}

export type AutoEvalResult = {
  message: string
  items: AutoEvalItem[]
  events: string[]
}

export function runAutoEvaluation(): AutoEvalResult {
  const { state, items, events } = autoEvaluate(loadState(), Date.now())
  saveState(state)
  const applied = items.filter((item) => item.applied).length
  const conflicts = items.filter((item) => item.note.includes('人工抢修结论优先')).length
  return {
    message: `自动研判完成：共 ${items.length} 台，推进 ${applied} 台，人工优先冲突 ${conflicts} 起`,
    items,
    events,
  }
}

export function listCommunicationEntries(filters: Record<string, string> = {}): PageResult {
  // 打开列表先回填：历史设备缺少最近通讯时刻按安装日期补齐
  const devices = listRows('communication')
  let changed = false
  const filled = devices.map((row) => {
    const result = backfillLastComm(row)
    if (result.backfilled) {
      changed = true
    }
    return result.row
  })
  if (changed) {
    saveRows('communication', filled)
  }
  const matched = filterRows(filled, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}
