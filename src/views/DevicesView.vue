<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore, type Device, type DeviceType } from '../stores/linkage'

const store = useLinkageStore()
const query = ref('')
const floor = ref('全部')
const dialog = ref(false)
const form = ref<Device>({ id: '', name: '', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '' })
const types: DeviceType[] = ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块', '输出模块', '排烟风机', '防火卷帘', '消防广播', '电梯']

const filtered = computed(() => store.devices.filter((item) => (floor.value === '全部' || item.floor === floor.value) && `${item.id}${item.name}${item.address}`.includes(query.value)))

function addDevice() {
  if (!form.value.id || !form.value.name || !form.value.address) return
  store.devices.push({ ...form.value })
  dialog.value = false
  form.value = { id: '', name: '', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '' }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">DEVICE REGISTER / 设备台账</p><h1>探测器、模块与消防设备</h1><p class="muted">先维护点位和楼层分区，再建立因果矩阵，避免无效地址引用。</p></div>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="dialog = true">新增点位</v-btn>
    </div>

    <div class="toolbar panel">
      <v-text-field v-model="query" label="搜索编号、名称或地址" prepend-inner-icon="mdi-magnify" density="compact" hide-details style="max-width:330px" />
      <v-select v-model="floor" :items="['全部','1F','2F']" label="楼层" density="compact" hide-details style="max-width:130px" />
      <v-spacer />
      <v-chip variant="tonal">共 {{ filtered.length }} 个点位</v-chip>
    </div>

    <div class="panel">
      <v-table hover>
        <thead><tr><th>点位编号</th><th>设备名称</th><th>类型</th><th>楼层 / 分区</th><th>回路地址</th><th>联动关系</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="device in filtered" :key="device.id">
            <td class="mono">{{ device.id }}</td>
            <td><strong>{{ device.name }}</strong></td>
            <td><v-chip size="small" variant="outlined">{{ device.type }}</v-chip></td>
            <td>{{ device.floor }} / {{ device.zone }}</td>
            <td class="mono">{{ device.address }}</td>
            <td>{{ store.rules.filter((rule) => rule.triggerId === device.id || rule.actionId === device.id).length }} 条</td>
            <td><v-chip size="small" color="success" variant="tonal">在线</v-chip></td>
          </tr>
        </tbody>
      </v-table>
    </div>

    <v-dialog v-model="dialog" max-width="620">
      <v-card>
        <v-card-title>新增消防点位</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="6"><v-text-field v-model="form.id" label="点位编号" /></v-col>
            <v-col cols="12" md="6"><v-select v-model="form.type" :items="types" label="设备类型" /></v-col>
            <v-col cols="12"><v-text-field v-model="form.name" label="设备名称" /></v-col>
            <v-col cols="6"><v-select v-model="form.floor" :items="['1F','2F','3F']" label="楼层" /></v-col>
            <v-col cols="6"><v-text-field v-model="form.zone" label="防火分区" /></v-col>
            <v-col cols="12"><v-text-field v-model="form.address" label="回路地址" placeholder="例如 2-B-01-03" /></v-col>
          </v-row>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="dialog=false">取消</v-btn><v-btn color="primary" @click="addDevice">保存点位</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 12px; }
.mono { color: #267078; font-family: ui-monospace,monospace; font-weight: 700; }
td strong { font-size: 13px; }
</style>
