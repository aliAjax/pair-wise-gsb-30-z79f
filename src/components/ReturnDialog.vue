<script setup lang="ts">
/**
 * 页面层：站方退油登记
 * 只能回原品空舱；界面实时显示每个舱在本站的可回装余量，
 * 超出余量的部分提示将转待处理，且不允许压占后续站点舱容。
 */
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useDeliveryStore } from "../stores/delivery";
import { compartmentReturnCapacity, round2 } from "../domain/rules";
import type { Trip } from "../types";

const props = defineProps<{ trip: Trip | null }>();
const emit = defineEmits<{ close: [] }>();

const store = useDeliveryStore();
const stationCode = ref("");
const fuelCode = ref("");
const tons = ref<number | null>(null);
const chosen = ref<string[]>([]);

const stationOptions = computed(() =>
  props.trip ? props.trip.route.map((code, i) => ({ code, order: i + 1, name: store.stationName(code) })) : []
);

watch(
  () => props.trip?.id,
  () => {
    stationCode.value = props.trip?.route[0] ?? "";
    fuelCode.value = store.fuels[0]?.code ?? "";
    tons.value = null;
    chosen.value = [];
  },
  { immediate: true }
);

const stationOrder = computed(() => {
  if (!props.trip) return 0;
  return props.trip.route.indexOf(stationCode.value) + 1;
});

/** 每舱在本站的退油回装可行性与余量 */
const compCaps = computed(() => {
  if (!props.trip || !fuelCode.value) return [];
  return props.trip
    ? store.getVehicle(props.trip.plate)!.compartments.map((c) => {
        const cap = compartmentReturnCapacity(props.trip!, stationOrder.value, c.no, fuelCode.value);
        return { no: c.no, ...cap };
      })
    : [];
});

const totalAvailable = computed(() =>
  round2(
    compCaps.value
      .filter((c) => chosen.value.includes(c.no))
      .reduce((a, c) => a + (c.ok ? c.capacity : 0), 0)
  )
);

const overflow = computed(() =>
  round2(Math.max(0, (tons.value ?? 0) - totalAvailable.value))
);

function toggle(no: string, ok: boolean) {
  if (!ok) return;
  const i = chosen.value.indexOf(no);
  if (i >= 0) chosen.value.splice(i, 1);
  else chosen.value.push(no);
}

function confirm() {
  if (!props.trip) return;
  if (!stationCode.value || !fuelCode.value || !(Number(tons.value) > 0)) {
    ElMessage.error("请完整填写退油站点、油品与吨数");
    return;
  }
  if (chosen.value.length === 0) {
    ElMessage.error("请至少选择一个原品空舱（全部装不下时将转待处理）");
    return;
  }
  const result = store.registerReturn(
    props.trip.id,
    stationCode.value,
    fuelCode.value,
    Number(tons.value),
    chosen.value
  );
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.warning(result.message);
  emit("close");
}
</script>

<template>
  <el-dialog title="站方退油登记" :model-value="trip !== null" width="640px" @close="emit('close')">
    <div v-if="trip" class="dlg">
      <el-alert
        title="退油只能回装原品空舱；余量按本站应卸同品载量计算，后续站点的舱容不可占用；装不下自动转待处理。"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="dlg-grid">
        <label>
          <span>退油站点</span>
          <el-select v-model="stationCode" style="width: 100%">
            <el-option
              v-for="s in stationOptions"
              :key="s.code"
              :label="`第${s.order}站 · ${s.name}`"
              :value="s.code"
            />
          </el-select>
        </label>
        <label>
          <span>退油油品（须为舱内原品）</span>
          <el-select v-model="fuelCode" style="width: 100%">
            <el-option v-for="f in store.fuels" :key="f.code" :label="f.name" :value="f.code" />
          </el-select>
        </label>
        <label>
          <span>退油吨数</span>
          <el-input-number v-model="tons" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
        </label>
      </div>

      <div class="cap-list">
        <p class="cap-title">选择回装舱（仅显示本站可卸的原品舱余量）：</p>
        <div
          v-for="c in compCaps"
          :key="c.no"
          class="cap-row"
          :class="{ disabled: !c.ok || c.capacity <= 0, picked: chosen.includes(c.no) }"
          @click="toggle(c.no, c.ok && c.capacity > 0)"
        >
          <el-checkbox :model-value="chosen.includes(c.no)" :disabled="!c.ok || c.capacity <= 0" />
          <strong>{{ c.no }}</strong>
          <template v-if="c.ok">
            <span class="ok">可回装 {{ c.capacity }} 吨</span>
          </template>
          <span v-else class="bad">{{ c.reason }}</span>
        </div>
      </div>

      <div class="sum-line">
        <span>申报 {{ round2(Number(tons ?? 0)) }} 吨</span>
        <span>选中舱余量 {{ totalAvailable }} 吨</span>
        <el-tag :type="overflow > 0 ? 'danger' : 'success'">
          {{ overflow > 0 ? `超出 ${overflow} 吨转待处理` : "余量充足" }}
        </el-tag>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" @click="confirm">确认退油</el-button>
    </template>
  </el-dialog>
</template>
