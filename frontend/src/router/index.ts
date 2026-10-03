import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Station = () => import('@/views/station/index.vue')
const Waterlevel = () => import('@/views/waterlevel/index.vue')
const Discharge = () => import('@/views/discharge/index.vue')
const Rainfall = () => import('@/views/rainfall/index.vue')
const Waterquality = () => import('@/views/waterquality/index.vue')
const Crosssection = () => import('@/views/crosssection/index.vue')
const Telemetry = () => import('@/views/telemetry/index.vue')
const Compilation = () => import('@/views/compilation/index.vue')
const Warning = () => import('@/views/warning/index.vue')
const Groundwater = () => import('@/views/groundwater/index.vue')
const Evaporation = () => import('@/views/evaporation/index.vue')
const Cableway = () => import('@/views/cableway/index.vue')
const Sediment = () => import('@/views/sediment/index.vue')
const Communication = () => import('@/views/communication/index.vue')
const Commfault = () => import('@/views/commfault/index.vue')
const Stationhouse = () => import('@/views/stationhouse/index.vue')
const Calibration = () => import('@/views/calibration/index.vue')
const Inspection = () => import('@/views/inspection/index.vue')
const Plan = () => import('@/views/plan/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/station', name: 'station', component: Station },
    { path: '/waterlevel', name: 'waterlevel', component: Waterlevel },
    { path: '/discharge', name: 'discharge', component: Discharge },
    { path: '/rainfall', name: 'rainfall', component: Rainfall },
    { path: '/waterquality', name: 'waterquality', component: Waterquality },
    { path: '/crosssection', name: 'crosssection', component: Crosssection },
    { path: '/telemetry', name: 'telemetry', component: Telemetry },
    { path: '/compilation', name: 'compilation', component: Compilation },
    { path: '/warning', name: 'warning', component: Warning },
    { path: '/groundwater', name: 'groundwater', component: Groundwater },
    { path: '/evaporation', name: 'evaporation', component: Evaporation },
    { path: '/cableway', name: 'cableway', component: Cableway },
    { path: '/sediment', name: 'sediment', component: Sediment },
    { path: '/communication', name: 'communication', component: Communication },
    { path: '/commfault', name: 'commfault', component: Commfault },
    { path: '/stationhouse', name: 'stationhouse', component: Stationhouse },
    { path: '/calibration', name: 'calibration', component: Calibration },
    { path: '/inspection', name: 'inspection', component: Inspection },
    { path: '/plan', name: 'plan', component: Plan },
  ],
})

export default router
