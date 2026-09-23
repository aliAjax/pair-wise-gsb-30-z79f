<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { PRODUCT_NAMES, STATIONS, TRUCKS, getTruck } from "../data/catalog";
import { demandShortages } from "../logic/rules";
import { useTripStore, type ActionResult } from "../store/trips";
import type { LoadDraft, StationStop, Trip, ValidationIssue } from "../types";
import { round3, sortedStops } from "../logic/helpers";

/** 同舱多行登记在判定前合并（跨品行仍由判定层拦截） */
function mergeLoads(drafts: LoadDraft[]): LoadDraft[] {
  const map = new Map<string, LoadDraft>();
  for (const draft of drafts) {
    const existing = map.get(draft.compartment);
    if (existing && existing.product === draft.product) {
      existing.weight = round3(existing.weight + draft.weight);
    } else {
      map.set(draft.compartment, { ...draft });
    }
  }
  return [...map.values()];
}

const props = defineProps<{ trip?: Trip }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const store = useTripStore();

interface StopDraftState {
  station: string;
  order: number;
  demands: Record<string, number>;
}

const plate = ref(props.trip?.plate ?? TRUCKS[0].plate);
const departAt = ref(props.trip?.departAt ?? new Date().toISOString().slice(0, 10));
const note = ref(props.trip?.note === "暂无备注" ? "" : props.trip?.note ?? "");
const loads = reactive<LoadDraft[]>([]);
const stops = reactive<StopDraftState[]>([]);
const issues = ref<ValidationIssue[]>([]);
const warnings = ref<ValidationIssue[]>([]);
const submitted = ref(false);

function blankLoad(): LoadDraft {
  return { compartment: "", product: PRODUCT_NAMES[0], weight: 0 };
}

function blankStop(order: number): StopDraftState {
  return {
    station: "",
    order,
    demands: Object.fromEntries(PRODUCT_NAMES.map((name) => [name, 0]))
  };
}

function resetFromTrip() {
  loads.splice(0, loads.length);
  stops.splice(0, stops.length);
  if (props.trip) {
    plate.value = props.trip.plate;
    departAt.value = props.trip.departAt;
    note.value = props.trip.note === "暂无备注" ? "" : props.trip.note;
    props.trip.loads.forEach((load) => loads.push({ ...load }));
    sortedStops(props.trip.stops).forEach((stop) =>
      stops.push({
        station: stop.station,
        order: stop.order,
        demands: Object.fromEntries(
          PRODUCT_NAMES.map((name) => [name, stop.demands[name] ?? 0])
        )
      })
    );
  } else {
    loads.push(blankLoad());
    stops.push(blankStop(1));
  }
  issues.value = [];
  warnings.value = [];
  submitted.value = false;
}

resetFromTrip();
watch(
  () => props.trip?.id,
  () => resetFromTrip()
);

const truck = computed(() => getTruck(plate.value));

watch(plate, (newPlate, oldPlate) => {
  const nextTruck = getTruck(newPlate);
  if (!nextTruck) return;
  const codes = nextTruck.compartments.map((item) => item.code);
  for (const load of loads) {
    if (load.compartment && !codes.includes(load.compartment)) load.compartment = "";
  }
  void oldPlate;
});

function addLoad() {
  loads.push(blankLoad());
}

function removeLoad(index: number) {
  loads.splice(index, 1);
}

function addStop() {
  stops.push(blankStop(stops.length + 1));
}

function removeStop(index: number) {
  stops.splice(index, 1);
  stops.forEach((stop, i) => (stop.order = i + 1));
}

const usedStations = computed(() => new Set(stops.map((item) => item.station).filter(Boolean)));

function normalizeStops(): StationStop[] {
  return stops
    .filter((stop) => stop.station)
    .map((stop, index) => ({
      station: stop.station,
      order: index + 1,
      demands: Object.fromEntries(
        Object.entries(stop.demands).filter(([, value]) => Number(value) > 0)
      )
    }));
}

const previewWarnings = computed(() => {
  if (!submitted.value) return [];
  const normalizedLoads = mergeLoads(
    loads.filter((item) => item.compartment && item.weight > 0)
  );
  return demandShortages(plate.value, normalizedLoads, normalizeStops());
});

function submit() {
  submitted.value = true;
  issues.value = [];
  warnings.value = [];

  const normalizedStops = normalizeStops();
  const validLoads = mergeLoads(loads.filter((item) => item.compartment));
  let result: ActionResult;
  if (props.trip) {
    // 编辑模式：先改装载，再改到站；失败时表单输入原样保留（整趟退回）
    result = store.editLoads(props.trip.id, validLoads);
    if (result.ok) result = store.editStops(props.trip.id, normalizedStops);
  } else {
    result = store.createTrip({
      plate: plate.value,
      departAt: departAt.value,
      note: note.value,
      loads: validLoads,
      stops: normalizedStops
    });
  }

  if (!result.ok) {
    // 整趟退回：不关闭、不清空，保留全部输入
    issues.value = result.issues;
    return;
  }

  warnings.value = demandShortages(
    plate.value,
    validLoads.map((item) => ({ ...item, weight: round3(item.weight) })),
    normalizedStops
  );
  if (!props.trip && warnings.value.length === 0) {
    resetFromTrip();
  }
  emit("saved");
}

const totalLoad = computed(() =>
  round3(loads.reduce((sum, item) => sum + (Number(item.weight) || 0), 0))
);
</script>

<template>
  <form class="panel trip-form" @submit.prevent="submit">
    <div class="panel-title">
      <h2>{{ trip ? "编辑趟次（未发车）" : "登记配送趟次" }}</h2>
      <span v-if="trip" class="status">{{ trip.code }}</span>
    </div>

    <div class="form-grid">
      <label>
        车辆（车牌）
        <select v-model="plate" :disabled="!!trip">
          <option v-for="item in TRUCKS" :key="item.plate" :value="item.plate">
            {{ item.plate }} · {{ item.name }}
          </option>
        </select>
      </label>
      <label>
        计划发车
        <input v-model="departAt" type="date" required />
      </label>
    </div>

    <div class="subhead">
      <h3>分舱装载登记</h3>
      <span class="hint">同舱只能装同品；超核定载重或跨品混装时整趟退回</span>
    </div>
    <div class="rows">
      <div v-for="(load, index) in loads" :key="index" class="row load-row">
        <select v-model="load.compartment" required>
          <option value="" disabled>舱号</option>
          <option
            v-for="compartment in truck?.compartments ?? []"
            :key="compartment.code"
            :value="compartment.code"
          >
            {{ compartment.code }}（限{{ compartment.capacity }}吨）
          </option>
        </select>
        <select v-model="load.product">
          <option v-for="name in PRODUCT_NAMES" :key="name" :value="name">{{ name }}</option>
        </select>
        <input v-model.number="load.weight" type="number" min="0" step="0.1" placeholder="载重（吨）" />
        <button type="button" class="secondary mini" @click="removeLoad(index)">删除</button>
      </div>
    </div>
    <button type="button" class="secondary mini" @click="addLoad">+ 增加舱位行</button>
    <p class="hint">合计登记：<strong>{{ totalLoad }}</strong> 吨</p>

    <div class="subhead">
      <h3>到站顺序与需求</h3>
      <span class="hint">按到站先后登记，顺序号即卸油次序</span>
    </div>
    <div class="rows">
      <div v-for="(stop, index) in stops" :key="index" class="stop-block">
        <div class="row">
          <span class="order-badge">第{{ index + 1 }}站</span>
          <select v-model="stop.station" required>
            <option value="" disabled>选择油站</option>
            <option
              v-for="station in STATIONS"
              :key="station.code"
              :value="station.name"
              :disabled="usedStations.has(station.name) && station.name !== stop.station"
            >
              {{ station.name }}
            </option>
          </select>
          <button type="button" class="secondary mini" @click="removeStop(index)">删除</button>
        </div>
        <div class="demand-grid">
          <label v-for="name in PRODUCT_NAMES" :key="name">
            {{ name }}需求（吨）
            <input v-model.number="stop.demands[name]" type="number" min="0" step="0.1" />
          </label>
        </div>
      </div>
    </div>
    <button type="button" class="secondary mini" @click="addStop">+ 增加到站</button>

    <label class="full-label">
      备注
      <textarea v-model="note" placeholder="填写处理说明或现场备注" />
    </label>

    <div v-if="issues.length" class="issue-box">
      <p v-for="(issue, index) in issues" :key="index" class="issue error">
        ✕ {{ issue.message }}
      </p>
    </div>
    <div v-if="previewWarnings.length" class="issue-box">
      <p v-for="(issue, index) in previewWarnings" :key="index" class="issue warn">
        ! {{ issue.message }}
      </p>
    </div>

    <div class="form-actions">
      <button type="submit">{{ trip ? "保存修改" : "保存配送趟次" }}</button>
      <button v-if="trip" type="button" class="secondary" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>
