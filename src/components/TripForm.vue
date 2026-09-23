<script setup lang="ts">
/**
 * 页面层：新建趟次登记表单
 * 登记车辆、舱位、油品、载重、到站顺序；
 * 跨品 / 超量 / 错序时整趟退回，表单输入原样保留并展示判定结果。
 */
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useDeliveryStore } from "../stores/delivery";
import { round2, validateLoads, type LoadDraft } from "../domain/rules";

const store = useDeliveryStore();

const plate = ref("");
const route = ref<string[]>([]);
const notes = ref("");
type Row = { compartmentNo: string; fuelCode: string; stationCode: string; tons: number | null };
const rows = ref<Row[]>([]);
const submittedViolations = ref<string[] | null>(null);

const vehicle = computed(() => store.getVehicle(plate.value));
const availableStations = computed(() => store.stations.filter((s) => !route.value.includes(s.code)));

watch(plate, () => {
  // 换车后舱位选项变化，清掉不存在的舱号
  if (!vehicle.value) return;
  const valid = new Set(vehicle.value.compartments.map((c) => c.no));
  rows.value = rows.value.filter((r) => valid.has(r.compartmentNo));
});

function addStation(code: string) {
  if (code && !route.value.includes(code)) route.value.push(code);
}
function moveStation(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= route.value.length) return;
  const [item] = route.value.splice(index, 1);
  route.value.splice(target, 0, item);
}
function removeStation(index: number) {
  const [code] = route.value.splice(index, 1);
  rows.value.forEach((r) => {
    if (r.stationCode === code) r.stationCode = "";
  });
}

function addRow() {
  if (!vehicle.value) {
    ElMessage.warning("请先选择车辆");
    return;
  }
  const first = vehicle.value.compartments[0];
  rows.value.push({
    compartmentNo: first.no,
    fuelCode: first.fuelCode ?? store.fuels[0].code,
    stationCode: route.value[0] ?? "",
    tons: null
  });
}
function removeRow(index: number) {
  rows.value.splice(index, 1);
}

/** 由到站顺序推导每行的顺序号 */
function draftsWithOrder(): LoadDraft[] {
  return rows.value
    .filter((r) => r.compartmentNo && r.fuelCode && r.stationCode && r.tons !== null)
    .map((r) => ({
      compartmentNo: r.compartmentNo,
      fuelCode: r.fuelCode,
      stationCode: r.stationCode,
      order: route.value.indexOf(r.stationCode) + 1,
      tons: Number(r.tons)
    }));
}

/** 实时预检（仅提示，不阻止编辑；提交时仍由存储层判定整趟退回） */
const precheck = computed(() => {
  if (!vehicle.value || route.value.length === 0) return { errors: [] as string[], comps: [] };
  const violations = validateLoads(vehicle.value, route.value, draftsWithOrder());
  const comps = vehicle.value.compartments.map((c) => {
    const inComp = draftsWithOrder().filter((d) => d.compartmentNo === c.no);
    const used = round2(inComp.reduce((a, d) => a + d.tons, 0));
    const fuelSet = new Set(inComp.map((d) => d.fuelCode));
    return {
      no: c.no,
      capacity: c.capacity,
      used,
      over: used > c.capacity + 1e-9,
      mixed: fuelSet.size > 1,
      limit: c.fuelCode ? store.fuelName(c.fuelCode) : "通用舱"
    };
  });
  return { errors: violations.filter((v) => v.level === "error").map((v) => v.message), comps };
});

function reset() {
  plate.value = "";
  route.value = [];
  rows.value = [];
  notes.value = "";
  submittedViolations.value = null;
}

function submit() {
  submittedViolations.value = null;
  if (!vehicle.value) {
    ElMessage.error("请选择车辆");
    return;
  }
  if (route.value.length === 0) {
    ElMessage.error("请登记到站顺序");
    return;
  }
  if (rows.value.length === 0 || rows.value.some((r) => r.tons === null || !(Number(r.tons) > 0))) {
    ElMessage.error("请完整登记每舱的油品、载重与到站");
    return;
  }
  const result = store.createTrip(plate.value, route.value, draftsWithOrder(), notes.value);
  if (!result.ok) {
    // 整趟退回：表单输入全部保留，仅展示退回原因
    submittedViolations.value = [
      result.message ?? "整趟退回",
      ...(result.violations ?? []).map((v) => v.message)
    ];
    ElMessage.error(result.message ?? "整趟退回");
    return;
  }
  ElMessage.success(result.message);
  reset();
}
</script>

<template>
  <section class="panel form-panel">
    <h2>登记配送趟次</h2>
    <el-alert
      title="同舱只能装同品；任一舱超量、跨品或到站顺序缺失，整趟退回且保留输入。发车后舱位与顺序冻结。"
      type="info"
      :closable="false"
      show-icon
      class="rule-tip"
    />

    <div class="form-body">
      <label class="field">
        <span>车辆（车牌）</span>
        <el-select v-model="plate" placeholder="请选择罐车" style="width: 100%">
          <el-option
            v-for="v in store.vehicles"
            :key="v.plate"
            :label="`${v.plate} · ${v.model}`"
            :value="v.plate"
          />
        </el-select>
      </label>

      <div v-if="vehicle" class="comp-brief">
        <el-tag
          v-for="c in precheck.comps"
          :key="c.no"
          :type="c.over || c.mixed ? 'danger' : c.used > 0 ? 'success' : 'info'"
          size="small"
        >
          {{ c.no }} 额定{{ c.capacity }}t / 已配{{ c.used }}t / {{ c.limit }}
        </el-tag>
      </div>

      <div class="field">
        <span>到站顺序</span>
        <div class="route-editor">
          <div v-for="(code, index) in route" :key="code" class="route-stop">
            <b>{{ index + 1 }}</b>
            <span>{{ store.stationName(code) }}</span>
            <el-button-group>
              <el-button size="small" :disabled="index === 0" @click="moveStation(index, -1)">上移</el-button>
              <el-button size="small" :disabled="index === route.length - 1" @click="moveStation(index, 1)">下移</el-button>
              <el-button size="small" type="danger" plain @click="removeStation(index)">移除</el-button>
            </el-button-group>
          </div>
          <div v-if="route.length === 0" class="empty-inline">尚未添加到站</div>
          <el-select
            v-if="availableStations.length"
            :model-value="''"
            placeholder="+ 添加到站"
            size="small"
            style="width: 220px"
            @change="addStation"
          >
            <el-option v-for="s in availableStations" :key="s.code" :label="s.name" :value="s.code" />
          </el-select>
        </div>
      </div>

      <div class="field">
        <div class="field-head">
          <span>舱位装载登记（舱号 / 油品 / 载重 / 到站）</span>
          <el-button size="small" type="primary" plain @click="addRow">加一行舱位</el-button>
        </div>
        <el-table v-if="rows.length" :data="rows" size="small" border>
          <el-table-column label="舱号" width="110">
            <template #default="{ row }">
              <el-select v-model="row.compartmentNo" style="width: 100%">
                <el-option
                  v-for="c in vehicle?.compartments ?? []"
                  :key="c.no"
                  :label="`${c.no}(${c.capacity}t)`"
                  :value="c.no"
                />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="油品" width="140">
            <template #default="{ row }">
              <el-select v-model="row.fuelCode" style="width: 100%">
                <el-option v-for="f in store.fuels" :key="f.code" :label="f.name" :value="f.code" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="载重(吨)" width="120">
            <template #default="{ row }">
              <el-input-number v-model="row.tons" :min="0" :step="1" :precision="2" controls-position="right" style="width: 100%" />
            </template>
          </el-table-column>
          <el-table-column label="到站（按顺序）">
            <template #default="{ row }">
              <el-select v-model="row.stationCode" placeholder="选择到站" style="width: 100%">
                <el-option
                  v-for="(code, i) in route"
                  :key="code"
                  :label="`第${i + 1}站 · ${store.stationName(code)}`"
                  :value="code"
                />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column width="70">
            <template #default="{ $index }">
              <el-button size="small" type="danger" link @click="removeRow($index)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <label class="field">
        <span>备注</span>
        <el-input v-model="notes" type="textarea" :rows="2" placeholder="处理说明 / 现场备注" />
      </label>

      <el-alert
        v-for="(msg, i) in submittedViolations ?? precheck.errors"
        :key="`${i}-${msg}`"
        :title="msg"
        type="error"
        :closable="false"
        show-icon
        class="violation"
      />

      <div class="form-actions">
        <el-button type="primary" @click="submit">保存趟次</el-button>
        <el-button @click="reset">清空</el-button>
      </div>
    </div>
  </section>
</template>
