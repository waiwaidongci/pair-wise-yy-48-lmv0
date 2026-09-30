<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const selectedRule = ref<string | null>(null)
const triggers = computed(() => store.devices.filter((device) => store.rules.some((rule) => rule.triggerId === device.id)))
const actions = computed(() => store.devices.filter((device) => store.rules.some((rule) => rule.actionId === device.id)))

function triggerY(index: number) { return 70 + index * 88 }
function actionY(index: number) { return 70 + index * 105 }
function sourceY(id: string) { return triggerY(triggers.value.findIndex((item) => item.id === id)) }
function targetY(id: string) { return actionY(actions.value.findIndex((item) => item.id === id)) }
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">DEPENDENCY GRAPH / 条件依赖</p><h1>触发、互锁与动作路径</h1><p class="muted">点击规则连线定位具体因果关系；跨区连线显示为橙色警示。</p></div>
      <v-chip variant="tonal" prepend-icon="mdi-alert-outline">{{ store.validations.length }} 个待确认路径</v-chip>
    </div>

    <div class="graph-wrap panel">
      <svg viewBox="0 0 1100 620" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#60777e" /></marker>
          <marker id="arrow-warn" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#bd6f2a" /></marker>
        </defs>
        <text x="80" y="26" class="column-title">触发点位</text>
        <text x="790" y="26" class="column-title">动作设备</text>
        <g v-for="(device, index) in triggers" :key="device.id">
          <rect x="40" :y="triggerY(index) - 26" width="230" height="52" rx="8" class="node trigger" />
          <text x="60" :y="triggerY(index) - 4" class="node-title">{{ device.name }}</text>
          <text x="60" :y="triggerY(index) + 13" class="node-sub">{{ device.id }} · {{ device.zone }}</text>
        </g>
        <g v-for="(device, index) in actions" :key="device.id">
          <rect x="760" :y="actionY(index) - 28" width="260" height="56" rx="8" class="node action" />
          <text x="782" :y="actionY(index) - 5" class="node-title">{{ device.name }}</text>
          <text x="782" :y="actionY(index) + 14" class="node-sub">{{ device.id }} · {{ device.zone }}</text>
        </g>
        <g v-for="rule in store.rules" :key="rule.id" @click="selectedRule = rule.id" class="edge-group">
          <path
            :d="`M 270 ${sourceY(rule.triggerId)} C 500 ${sourceY(rule.triggerId)}, 530 ${targetY(rule.actionId)}, 760 ${targetY(rule.actionId)}`"
            fill="none"
            :class="['edge', { disabled: !rule.enabled, selected: selectedRule === rule.id, warning: store.validations.some((item) => item.ruleIds.includes(rule.id)) }]"
            :marker-end="store.validations.some((item) => item.ruleIds.includes(rule.id)) ? 'url(#arrow-warn)' : 'url(#arrow)'"
          />
          <circle :cx="515" :cy="(sourceY(rule.triggerId) + targetY(rule.actionId)) / 2" r="12" class="rule-node" />
          <text :x="515" :y="(sourceY(rule.triggerId) + targetY(rule.actionId)) / 2 + 4" text-anchor="middle" class="rule-id">{{ rule.id.slice(-3) }}</text>
        </g>
      </svg>
      <div class="graph-side" v-if="selectedRule">
        <v-btn icon="mdi-close" size="small" variant="text" @click="selectedRule = null" />
        <strong>{{ selectedRule }}</strong>
        <v-select :model-value="store.rules.find((rule) => rule.id === selectedRule)?.priority" :items="[1,2,3]" label="优先级" density="compact" />
        <v-text-field :model-value="store.rules.find((rule) => rule.id === selectedRule)?.interlock" label="互锁条件" density="compact" />
        <v-switch :model-value="store.rules.find((rule) => rule.id === selectedRule)?.enabled" label="规则启用" color="primary" @update:model-value="store.updateRule(selectedRule!, { enabled: Boolean($event) })" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.graph-wrap { position: relative; overflow: auto; }
svg { display: block; min-width: 900px; width: 100%; background: radial-gradient(circle, #d9dfe0 1px, transparent 1px); background-size: 22px 22px; }
.column-title { fill: #64757c; font-size: 13px; font-weight: 800; letter-spacing: .12em; }
.node { fill: white; stroke-width: 1.6; }
.node.trigger { stroke: #397a82; }
.node.action { stroke: #a64c35; }
.node-title { fill: #253a42; font-size: 12px; font-weight: 700; }
.node-sub { fill: #718188; font-size: 10px; }
.edge { stroke: #60777e; stroke-width: 2; opacity: .75; cursor: pointer; }
.edge.selected { stroke: #1e6772; stroke-width: 4; opacity: 1; }
.edge.warning { stroke: #bd6f2a; stroke-dasharray: 7 5; opacity: 1; }
.edge.disabled { stroke: #aeb8bb; opacity: .35; }
.rule-node { fill: white; stroke: #597177; stroke-width: 1.5; }
.rule-id { fill: #4f666d; font-size: 8px; font-weight: 800; }
.edge-group { cursor: pointer; }
.graph-side { position: absolute; top: 18px; right: 18px; width: 260px; padding: 14px; border: 1px solid #dbe2e3; border-radius: 9px; background: rgba(255,255,255,.96); box-shadow: 0 8px 25px rgba(31,54,62,.12); }
.graph-side strong { display: block; margin: 5px 0 12px; }
</style>
