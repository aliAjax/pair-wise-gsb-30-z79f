<script setup lang="ts">
/**
 * 页面层：到站卸油登记
 * 按舱逐舱登记本次实卸吨数，不得超过该舱计划剩余。
 */
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useDeliveryStore } from "../stores/delivery";
import { deliveredOf, round2 } from "../domain/rules";
import type { Trip } from "../types";

const props = defineProps<{ trip: Trip | null }>();
const emit = defineEmits<{ close: [] }>();

const store = useDeliveryStore();
const stationCode = ref("");
/** loadId -> 本次卸油吨数 */
const amounts = ref<Record<string, number | null>>({});

watch(
  () => props.trip?.id,
  () => {
    stationCode.value = props.trip?.route[0] ?? "";
    amounts.value = {};
  },
  { immediate: true }
);

const stationOptions = computed(() =>
  props.trip ? props.trip.route.map((code, i) => ({ code, order: i + 1, name: store.stationName(code) })) : []
);

const stationLoads = computed(() => {
  if (!props.trip) return [];
  return props.trip.loads
    .filter((l) => !l.void && l.stationCode === stationCode.value)
    .map((l) => ({
      ...l,
      fuelName: store.fuelName(l.fuelCode),
      delivered: deliveredOf(l),
      remaining: round2(l.tons - deliveredOf(l))
    }));
});

function setAll(loadId: string, remaining: number) {
  amounts.value[loadId] = remaining;
}

function confirm() {
  if (!props.trip) return;
  const deliveries = stationLoads.value
    .map((l) => ({ loadId: l.id, tons: Number(amounts.value[l.id] ?? 0) }))
    .filter((d) => d.tons > 0);
  if (deliveries.length === 0) {
    ElMessage.warning("请填写至少一舱的本次卸油吨数");
    return;
  }
  const result = store.registerDelivery(props.trip.id, deliveries);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  emit("close");
}
</script>

<template>
  <el-dialog title="到站卸油登记" :model-value="trip !== null" width="640px" @close="emit('close')">
    <div v-if="trip" class="dlg">
      <label class="one-line">
        <span>到站</span>
        <el-select v-model="stationCode" style="width: 260px">
          <el-option
            v-for="s in stationOptions"
            :key="s.code"
            :label="`第${s.order}站 · ${s.name}`"
            :value="s.code"
          />
        </el-select>
      </label>

      <el-table :data="stationLoads" size="small" border class="deliver-table">
        <el-table-column prop="compartmentNo" label="舱号" width="80" />
        <el-table-column prop="fuelName" label="油品" width="120" />
        <el-table-column label="计划/已卸/剩余" width="170">
          <template #default="{ row }">
            {{ row.tons }} / {{ row.delivered }} / <b>{{ row.remaining }}</b> 吨
          </template>
        </el-table-column>
        <el-table-column label="本次实卸(吨)">
          <template #default="{ row }">
            <div class="amount-cell">
              <el-input-number
                v-model="amounts[row.id]"
                :min="0"
                :max="row.remaining"
                :precision="2"
                :step="1"
                controls-position="right"
                size="small"
                style="width: 130px"
              />
              <el-button size="small" link type="primary" @click="setAll(row.id, row.remaining)">全部</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        v-if="stationLoads.length === 0"
        title="该站没有可登记的有效舱位计划"
        type="info"
        :closable="false"
      />
    </div>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" @click="confirm">确认卸油</el-button>
    </template>
  </el-dialog>
</template>
