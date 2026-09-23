<script setup lang="ts">
/**
 * 页面层：重开后的修订操作
 * 发车后舱位与顺序冻结，只有"重开"状态可调整；
 * 任一调整都必须填写原因，旧值→新值由存储层写入修订记录。
 */
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useDeliveryStore } from "../stores/delivery";
import type { Trip } from "../types";

const props = defineProps<{ trip: Trip | null }>();
const emit = defineEmits<{ close: [] }>();

const store = useDeliveryStore();
const tab = ref<"load" | "route" | "plate">("load");

// 舱位调整草稿：loadId -> 草稿
const loadDrafts = ref<Record<string, { compartmentNo: string; fuelCode: string; stationCode: string; tons: number | null }>>({});
const loadReason = ref("");
const voidReason = ref("");
const voidTarget = ref<string | null>(null);

// 顺序调整
const routeDraft = ref<string[]>([]);
const routeReason = ref("");

// 换车
const plateDraft = ref("");
const plateReason = ref("");

const reopenReason = ref("");

watch(
  () => props.trip?.id,
  () => {
    tab.value = "load";
    loadReason.value = "";
    voidReason.value = "";
    voidTarget.value = null;
    routeReason.value = "";
    plateReason.value = "";
    reopenReason.value = "";
    plateDraft.value = props.trip?.plate ?? "";
    routeDraft.value = props.trip ? [...props.trip.route] : [];
    loadDrafts.value = {};
    if (props.trip) {
      props.trip.loads.filter((l) => !l.void).forEach((l) => {
        loadDrafts.value[l.id] = {
          compartmentNo: l.compartmentNo,
          fuelCode: l.fuelCode,
          stationCode: l.stationCode,
          tons: l.tons
        };
      });
    }
  },
  { immediate: true }
);

const trip = computed(() => props.trip);
const isReopen = computed(() => trip.value?.status === "重开");
const vehicle = computed(() => (trip.value ? store.getVehicle(trip.value.plate) : undefined));

const effectiveLoads = computed(() =>
  trip.value ? trip.value.loads.filter((l) => !l.void) : []
);

function doReopen() {
  if (!trip.value) return;
  const r = store.reopen(trip.value.id, reopenReason.value);
  if (!r.ok) ElMessage.error(r.message);
  else ElMessage.success(r.message);
}

function moveStop(index: number, delta: number) {
  const t = index + delta;
  if (t < 0 || t >= routeDraft.value.length) return;
  const [item] = routeDraft.value.splice(index, 1);
  routeDraft.value.splice(t, 0, item);
}

function submitLoad(loadId: string) {
  if (!trip.value) return;
  const d = loadDrafts.value[loadId];
  if (!d || !(Number(d.tons) > 0)) {
    ElMessage.error("载重必须大于 0");
    return;
  }
  const r = store.reviseLoad(
    trip.value.id,
    loadId,
    { compartmentNo: d.compartmentNo, fuelCode: d.fuelCode, stationCode: d.stationCode, tons: Number(d.tons) },
    loadReason.value
  );
  if (!r.ok) {
    ElMessage.error(r.message);
  } else {
    ElMessage.success(r.message);
    loadReason.value = "";
    emit("close");
  }
}

function submitVoid(loadId: string) {
  if (!trip.value) return;
  const r = store.voidLoad(trip.value.id, loadId, voidReason.value);
  if (!r.ok) {
    ElMessage.error(r.message);
  } else {
    ElMessage.success(r.message);
    voidReason.value = "";
    voidTarget.value = null;
    emit("close");
  }
}

function submitRoute() {
  if (!trip.value) return;
  const r = store.reviseRouteOrder(trip.value.id, routeDraft.value, routeReason.value);
  if (!r.ok) ElMessage.error(r.message);
  else {
    ElMessage.success(r.message);
    routeReason.value = "";
    emit("close");
  }
}

function submitPlate() {
  if (!trip.value) return;
  const r = store.revisePlate(trip.value.id, plateDraft.value, plateReason.value);
  if (!r.ok) {
    ElMessage.error(r.message);
    (r.violations ?? []).forEach((v) => ElMessage.warning(v.message));
  } else {
    ElMessage.success(r.message);
    plateReason.value = "";
    emit("close");
  }
}
</script>

<template>
  <el-dialog title="冻结调整与重开修订" :model-value="trip !== null" width="820px" @close="emit('close')">
    <div v-if="trip" class="dlg">
      <!-- 未重开：先重开 -->
      <template v-if="!isReopen">
        <el-alert
          title="该趟已发车，舱位与到站顺序处于冻结状态。调整前必须重开本趟，并填写重开原因。"
          type="warning"
          :closable="false"
          show-icon
        />
        <label class="one-line" style="margin-top: 14px">
          <span>重开原因</span>
          <el-input v-model="reopenReason" type="textarea" :rows="2" style="max-width: 480px" placeholder="必须说明为什么要解除冻结" />
        </label>
      </template>

      <!-- 已重开：三个修订页签 -->
      <template v-else>
        <el-alert
          title="本趟已重开。任何调整都会保留旧值→新值与原因；再次发车前系统核对配送、舱位、退油与修订是否对应。"
          type="success"
          :closable="false"
          show-icon
        />
        <el-tabs v-model="tab" class="revise-tabs">
          <el-tab-pane label="舱位计划调整" name="load">
            <el-table :data="effectiveLoads" size="small" border>
              <el-table-column label="原舱号" width="80">
                <template #default="{ row }">{{ row.compartmentNo }}</template>
              </el-table-column>
              <el-table-column label="调整舱号" width="110">
                <template #default="{ row }">
                  <el-select v-model="loadDrafts[row.id].compartmentNo" size="small">
                    <el-option
                      v-for="c in vehicle?.compartments ?? []"
                      :key="c.no"
                      :label="c.no"
                      :value="c.no"
                    />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="调整油品" width="130">
                <template #default="{ row }">
                  <el-select v-model="loadDrafts[row.id].fuelCode" size="small">
                    <el-option v-for="f in store.fuels" :key="f.code" :label="f.name" :value="f.code" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="载重" width="110">
                <template #default="{ row }">
                  <el-input-number
                    v-model="loadDrafts[row.id].tons"
                    :min="0"
                    :precision="2"
                    :step="1"
                    size="small"
                    controls-position="right"
                    style="width: 100%"
                  />
                </template>
              </el-table-column>
              <el-table-column label="到站" width="150">
                <template #default="{ row }">
                  <el-select v-model="loadDrafts[row.id].stationCode" size="small">
                    <el-option
                      v-for="(code, i) in trip.route"
                      :key="code"
                      :label="`第${i + 1}站·${store.stationName(code)}`"
                      :value="code"
                    />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column width="150">
                <template #default="{ row }">
                  <template v-if="voidTarget === row.id">
                    <el-input v-model="voidReason" size="small" placeholder="作废原因" @keyup.enter="submitVoid(row.id)" />
                    <el-button size="small" type="danger" link @click="submitVoid(row.id)">确认</el-button>
                    <el-button size="small" link @click="voidTarget = null">取消</el-button>
                  </template>
                  <div v-else class="row-ops">
                    <el-button size="small" type="primary" link @click="submitLoad(row.id)">提交调整</el-button>
                    <el-button size="small" type="danger" link @click="voidTarget = row.id">作废</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
            <label class="reason-line">
              <span>调整原因（必填，提交调整时使用）</span>
              <el-input v-model="loadReason" placeholder="说明调整舱位/油品/载重/到站的原因" />
            </label>
            <p class="hint">提交后原计划行标记作废保留（修订痕迹），新计划重新校验同舱同品与载重；整舱油品已全部卸净时可直接"作废"该计划行。</p>
          </el-tab-pane>

          <el-tab-pane label="到站顺序调整" name="route">
            <div v-for="(code, i) in routeDraft" :key="code" class="route-edit-row">
              <b>第{{ i + 1 }}站</b>
              <span>{{ store.stationName(code) }}</span>
              <el-button size="small" :disabled="i === 0" @click="moveStop(i, -1)">上移</el-button>
              <el-button size="small" :disabled="i === routeDraft.length - 1" @click="moveStop(i, 1)">下移</el-button>
            </div>
            <label class="reason-line">
              <span>调整原因（必填）</span>
              <el-input v-model="routeReason" placeholder="说明调整到站顺序的原因" />
            </label>
            <el-button type="primary" size="small" @click="submitRoute">保存顺序</el-button>
          </el-tab-pane>

          <el-tab-pane label="更换车辆" name="plate">
            <label class="one-line">
              <span>新车牌</span>
              <el-select v-model="plateDraft" style="width: 320px">
                <el-option
                  v-for="v in store.vehicles"
                  :key="v.plate"
                  :label="`${v.plate} · ${v.model}`"
                  :value="v.plate"
                />
              </el-select>
            </label>
            <label class="reason-line">
              <span>换车原因（必填）</span>
              <el-input v-model="plateReason" placeholder="说明换车原因，新车舱位将重新校验" />
            </label>
            <el-button type="primary" size="small" @click="submitPlate">确认换车</el-button>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
    <template #footer>
      <template v-if="!isReopen">
        <el-button @click="emit('close')">取消</el-button>
        <el-button type="warning" @click="doReopen">重开本趟</el-button>
      </template>
      <el-button v-else @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>
