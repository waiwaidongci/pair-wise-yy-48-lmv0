<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useLinkageStore } from './stores/linkage'

const route = useRoute()
const store = useLinkageStore()
const drawer = ref(true)
const title = computed(() => String(route.meta.title ?? '消防联动'))

const items = [
  { to: '/', title: '项目总览', icon: 'mdi-view-dashboard-outline' },
  { to: '/devices', title: '设备与分区', icon: 'mdi-access-point' },
  { to: '/matrix', title: '因果矩阵', icon: 'mdi-grid-large' },
  { to: '/dependency', title: '依赖图', icon: 'mdi-graph-outline' },
  { to: '/review', title: '版本审阅', icon: 'mdi-file-compare' },
]
</script>

<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :permanent="$vuetify.display.mdAndUp" color="#25363C" width="244">
      <div class="brand">
        <div class="brand-mark"><v-icon icon="mdi-fire-alert" /></div>
        <div><strong>联动逻辑台</strong><small>滨江研发中心 · 消防专业</small></div>
      </div>
      <v-list nav class="nav-list">
        <v-list-item v-for="item in items" :key="item.to" :to="item.to" :prepend-icon="item.icon" :title="item.title" rounded="lg" />
      </v-list>
      <template #append>
        <div class="side-status">
          <div><span class="status-dot" :class="{ locked: store.locked, offline: !store.online }" />{{ store.locked ? '基线已签字锁定' : store.online ? '协同编辑中' : '断网 · 批次记录中' }}</div>
          <small>基线 R{{ store.remoteRevision }} · 本机 R{{ store.revision }} · {{ store.validations.length }} 项校验提示</small>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar flat class="app-bar" height="52">
      <v-app-bar-nav-icon class="d-md-none" @click="drawer = !drawer" />
      <v-app-bar-title>{{ title }}</v-app-bar-title>
      <v-spacer />
      <v-chip size="small" variant="tonal" :color="store.online ? 'success' : 'warning'" :prepend-icon="store.online ? 'mdi-cloud-check-outline' : 'mdi-cloud-off-outline'">
        {{ store.online ? '在线' : '断网' }} · 批次 {{ store.batchProgress.applied }}/{{ store.batchProgress.total }}
      </v-chip>
    </v-app-bar>

    <v-main>
      <RouterView />
    </v-main>
  </v-app>
</template>

<style scoped>
.brand { display: flex; align-items: center; gap: 11px; padding: 20px 16px; color: #eef3f4; border-bottom: 1px solid rgba(255,255,255,.1); }
.brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #d36b55; border-radius: 9px; color: #f0a391; }
.brand strong, .brand small { display: block; }
.brand strong { font-size: 14px; }
.brand small { margin-top: 4px; color: #9eb0b5; font-size: 10px; }
.nav-list { padding: 15px 10px; }
.nav-list :deep(.v-list-item--active) { color: white; background: #38525a; box-shadow: inset 3px 0 #cf634d; }
.side-status { margin: 12px; padding: 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: #dce6e9; background: rgba(255,255,255,.04); }
.side-status div { font-size: 11px; font-weight: 700; }
.side-status small { display: block; margin-top: 6px; color: #93a7ad; font-size: 9px; }
.status-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: #59b58a; }
.status-dot.locked { background: #d79a45; }
.status-dot.offline { background: #d28a2d; }
.app-bar { border-bottom: 1px solid #e0e5e5; background: white; }
</style>
