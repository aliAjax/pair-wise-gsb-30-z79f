<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { PRODUCT_NAMES, getCompartmentCapacity } from "../data/catalog";
import { useTripStore } from "../store/trips";
import type { Trip, ValidationIssue } from "../types";
import {
  availableAtCurrentStop,
  effectiveLoads,
  formatNumber,
  loadProduct,
  onboardBeforeStop,
  round3,
  sortedStops,
  stopDeliveredWeight,
  stopHandled,
  stopReturnedWeight
} from "../logic/helpers";

const props = defineProps<{ trip: Trip }>();
const emit = defineEmits<{ edit: [trip: Trip] }>();

const store = useTripStore();
const inlineIssues = ref<ValidationIssue[]>([]);
const inlineNotes = ref<string[]>([]);

function flash(result: { ok: boolean; issues: ValidationIssue[]; warnings?: ValidationIssue[] }) {
  inlineIssues.value = result.ok ? [] : result.issues;
  inlineNotes.value = result.ok && result.warnings ? result.warnings.map((item) => item.message) : [];
}

const stops = computed(() => sortedStops(props.trip.stops));
const currentStop = computed(() => stops.value[props.trip.currentStopIndex]);
const effectiveMap = computed(() => new Map(effectiveLoads(props.trip).map((item) => [item.compartment, item])));
const onboard = computed(() =>
  currentStop.value ? onboardBeforeStop(props.trip, currentStop.value.order) : new Map<string, number>()
);

const compartments = computed(() =>
  props.trip.loads
    .map((load) => load.compartment)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
);

const conflicts = computed(() => store.conflictsOf(props.trip.id));

// ---- 交付登记 ----
const deliveryDraft = reactive({ compartment: "", weight: 0 });
const deliveryProduct = computed(() =>
  deliveryDraft.compartment ? loadProduct(props.trip, deliveryDraft.compartment) : ""
);
const deliveryAvailable = computed(() =>
  deliveryDraft.compartment ? availableAtCurrentStop(props.trip, deliveryDraft.compartment) : 0
);

function submitDelivery() {
  if (!currentStop.value) return;
  const result = store.addDelivery(props.trip.id, {
    station: currentStop.value.station,
    compartment: deliveryDraft.compartment,
    product: deliveryProduct.value,
    weight: Number(deliveryDraft.weight)
  });
  flash(result);
  if (result.ok) {
    deliveryDraft.compartment = "";
    deliveryDraft.weight = 0;
  }
}

// ---- 站方退油 ----
const returnDraft = reactive({ product: PRODUCT_NAMES[0], weight: 0, note: "" });
function submitReturn() {
  const result = store.addReturn(props.trip.id, {
    product: returnDraft.product,
    weight: Number(returnDraft.weight),
    note: returnDraft.note
  });
  flash(result);
  if (result.ok) {
    returnDraft.weight = 0;
    returnDraft.note = "";
  }
}

// ---- 载重调整（留原因和旧值） ----
const weightDraft = reactive({ compartment: "", weight: 0, reason: "" });
function startWeight(compartment: string) {
  const effective = effectiveMap.value.get(compartment);
  weightDraft.compartment = compartment;
  weightDraft.weight = effective?.weight ?? 0;
  weightDraft.reason = "";
}
function submitWeight() {
  flash(
    store.adjustWeight(props.trip.id, weightDraft.compartment, Number(weightDraft.weight), weightDraft.reason)
  );
}

// ---- 油品调整 ----
const productDraft = reactive({ compartment: "", product: "", reason: "" });
function startProduct(compartment: string) {
  productDraft.compartment = compartment;
  productDraft.product = loadProduct(props.trip, compartment);
  productDraft.reason = "";
}
function submitProduct() {
  flash(
    store.adjustProduct(props.trip.id, productDraft.compartment, productDraft.product, productDraft.reason)
  );
}

// ---- 到站顺序调整（重开后） ----
const orderEdit = ref(false);
const orderReason = ref("");
const orderDrafts = reactive<{ station: string; order: number }[]>([]);
function startOrderEdit() {
  orderDrafts.splice(0, orderDrafts.length);
  stops.value.forEach((stop) => orderDrafts.push({ station: stop.station, order: stop.order }));
  orderReason.value = "";
  orderEdit.value = true;
}
function submitOrder() {
  flash(store.adjustOrder(props.trip.id, orderDrafts.map((item) => ({ ...item })), orderReason.value));
  if (inlineIssues.value.length === 0) orderEdit.value = false;
}

// ---- 重开原因 ----
const reopenStopReason = ref("");
const reopenTripReason = ref("");
function submitReopenStop() {
  flash(store.reopenStop(props.trip.id, reopenStopReason.value));
  if (inlineIssues.value.length === 0) reopenStopReason.value = "";
}
function submitReopenTrip() {
  flash(store.reopenTrip(props.trip.id, reopenTripReason.value));
  if (inlineIssues.value.length === 0) reopenTripReason.value = "";
}

const showOperations = computed(
  () => props.trip.frozen && props.trip.status !== "已到站"
);

const revisionsSorted = computed(() =>
  [...props.trip.revisions].sort((a, b) => b.at.localeCompare(a.at))
);

function fmtTime(value: string): string {
  return value ? value.replace("T", " ").slice(0, 16) : "";
}
</script>

<template>
  <article class="trip-card">
    <header class="trip-head">
      <div>
        <p class="trip-code">
          {{ trip.code }}
          <span class="plate">{{ trip.plate }}</span>
        </p>
        <p class="trip-meta">计划发车 {{ trip.departAt }} · 创建于 {{ fmtTime(trip.createdAt) }}</p>
      </div>
      <span class="status" :class="`st-${trip.status}`">{{ trip.status }}</span>
    </header>

    <p v-if="trip.frozen" class="freeze-tip">
      🔒 已发车：舱位与到站顺序冻结
      <template v-if="trip.adjustUnlocked">；行程已重开，可凭原因调整油品与顺序</template>
    </p>

    <!-- 分舱装载 -->
    <section class="block">
      <h4>分舱装载与在舱量</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>舱号</th><th>油品</th><th>登记载重</th><th>账面载重</th><th>核定</th>
            <th v-if="trip.frozen">到本站前在舱</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="compartment in compartments" :key="compartment">
            <td>{{ compartment }}</td>
            <td>{{ effectiveMap.get(compartment)?.product }}</td>
            <td>{{ formatNumber(trip.loads.find((l) => l.compartment === compartment)?.weight ?? 0) }}</td>
            <td>
              <strong>{{ formatNumber(effectiveMap.get(compartment)?.weight ?? 0) }}</strong>
            </td>
            <td>{{ getCompartmentCapacity(trip.plate, compartment) }}</td>
            <td v-if="trip.frozen">{{ formatNumber(onboard.get(compartment) ?? 0) }}</td>
            <td class="ops">
              <button type="button" class="link-btn" @click="startWeight(compartment)">载重调整</button>
              <button
                type="button"
                class="link-btn"
                :disabled="trip.frozen && !trip.adjustUnlocked"
                @click="startProduct(compartment)"
              >油品调整</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 载重调整弹层（内联） -->
    <section v-if="weightDraft.compartment" class="inline-form">
      <h4>载重调整 · {{ weightDraft.compartment }}（{{ loadProduct(trip, weightDraft.compartment) }}）</h4>
      <div class="row">
        <label>新载重（吨）
          <input v-model.number="weightDraft.weight" type="number" min="0" step="0.1" />
        </label>
        <label class="grow">调整原因（必填，旧值自动留痕）
          <input v-model="weightDraft.reason" placeholder="如：过磅误差、现场复测" />
        </label>
        <button type="button" @click="submitWeight">提交调整</button>
        <button type="button" class="secondary" @click="weightDraft.compartment = ''">关闭</button>
      </div>
    </section>

    <section v-if="productDraft.compartment" class="inline-form">
      <h4>油品调整 · {{ productDraft.compartment }}</h4>
      <div class="row">
        <label>新油品
          <select v-model="productDraft.product">
            <option v-for="name in PRODUCT_NAMES" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="grow">调整原因（必填）
          <input v-model="productDraft.reason" placeholder="重开后改舱需写明原因" />
        </label>
        <button type="button" @click="submitProduct">提交改品</button>
        <button type="button" class="secondary" @click="productDraft.compartment = ''">关闭</button>
      </div>
    </section>

    <!-- 到站顺序 -->
    <section class="block">
      <div class="block-head">
        <h4>到站顺序</h4>
        <button
          v-if="trip.frozen && trip.adjustUnlocked && !orderEdit"
          type="button"
          class="link-btn"
          @click="startOrderEdit"
        >调整顺序</button>
      </div>
      <ol class="stops">
        <li
          v-for="(stop, index) in stops"
          :key="stop.station"
          class="stop"
          :class="{ current: trip.frozen && index === trip.currentStopIndex, done: stopHandled(trip, stop.station) }"
        >
          <span class="order-badge">第{{ stop.order }}站</span>
          <strong>{{ stop.station }}</strong>
          <span class="demands">
            <em v-for="(value, product) in stop.demands" :key="product">
              {{ product }} 需{{ value }}
            </em>
          </span>
          <span v-if="stopDeliveredWeight(trip, stop.station) || stopReturnedWeight(trip, stop.station)" class="settled">
            已交 {{ formatNumber(stopDeliveredWeight(trip, stop.station)) }} 吨
            <template v-if="stopReturnedWeight(trip, stop.station)">
              / 退回 {{ formatNumber(stopReturnedWeight(trip, stop.station)) }} 吨
            </template>
          </span>
        </li>
      </ol>

      <div v-if="orderEdit" class="inline-form">
        <div v-for="item in orderDrafts" :key="item.station" class="row compact">
          <span>{{ item.station }}</span>
          <input v-model.number="item.order" type="number" min="1" :max="orderDrafts.length" />
        </div>
        <label class="grow">调整原因（必填，旧顺序自动留痕）
          <input v-model="orderReason" placeholder="如：道路管制，机场站与新区站互换" />
        </label>
        <div class="row">
          <button type="button" @click="submitOrder">保存新顺序</button>
          <button type="button" class="secondary" @click="orderEdit = false">取消</button>
        </div>
      </div>
    </section>

    <!-- 运输中：当前站交付 / 退油 -->
    <section v-if="showOperations && currentStop" class="block ops-grid">
      <form class="op-box" @submit.prevent="submitDelivery">
        <h4>到站交付 · {{ currentStop.station }}</h4>
        <label>选择舱位
          <select v-model="deliveryDraft.compartment" required>
            <option value="" disabled>选择卸油舱</option>
            <option
              v-for="compartment in compartments"
              :key="compartment"
              :value="compartment"
              :disabled="(onboard.get(compartment) ?? 0) <= 0"
            >
              {{ compartment }} · {{ loadProduct(trip, compartment) }}
              （可卸 {{ formatNumber(onboard.get(compartment) ?? 0) }} 吨）
            </option>
          </select>
        </label>
        <label>本次卸油（吨）
          <input v-model.number="deliveryDraft.weight" type="number" min="0" step="0.1" required />
        </label>
        <p v-if="deliveryDraft.compartment" class="hint">
          {{ deliveryProduct }} 本站可卸余量 {{ formatNumber(deliveryAvailable) }} 吨
        </p>
        <button type="submit">登记交付</button>
      </form>

      <form class="op-box" @submit.prevent="submitReturn">
        <h4>站方退油 · {{ currentStop.station }}</h4>
        <label>退回油品
          <select v-model="returnDraft.product">
            <option v-for="name in PRODUCT_NAMES" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label>退回数量（吨）
          <input v-model.number="returnDraft.weight" type="number" min="0" step="0.1" required />
        </label>
        <label>退油说明
          <input v-model="returnDraft.note" placeholder="如：清罐、化验退回" />
        </label>
        <p class="hint">只能回原品空舱/余量舱，入不下转待处理，不压占后续站</p>
        <button type="submit">登记退油</button>
      </form>
    </section>

    <!-- 已登记的交付与退油 -->
    <section v-if="trip.deliveries.length || trip.returns.length" class="block logs-grid">
      <div v-if="trip.deliveries.length">
        <h4>交付记录</h4>
        <ul class="log-list">
          <li v-for="delivery in trip.deliveries" :key="delivery.id">
            <span>{{ fmtTime(delivery.at) }}</span>
            {{ delivery.station }} · {{ delivery.compartment }} · {{ delivery.product }}
            <strong>{{ formatNumber(delivery.weight) }}吨</strong>
          </li>
        </ul>
      </div>
      <div v-if="trip.returns.length">
        <h4>退油记录（入舱分配 / 待处理）</h4>
        <ul class="log-list">
          <li v-for="item in trip.returns" :key="item.id" :class="{ overflow: item.overflow > 0 }">
            <span>{{ fmtTime(item.at) }}</span>
            {{ item.station }} · {{ item.product }} 退{{ formatNumber(item.requested) }}吨：
            <template v-if="item.allocations.length">
              <em v-for="(allocation, i) in item.allocations" :key="i">
                {{ allocation.compartment }}入{{ formatNumber(allocation.weight) }}吨
              </em>
            </template>
            <em v-else>无舱可入</em>
            <strong v-if="item.overflow > 0" class="badge-warn">
              {{ formatNumber(item.overflow) }}吨转待处理
            </strong>
          </li>
        </ul>
      </div>
    </section>

    <!-- 修订留痕 -->
    <section v-if="revisionsSorted.length" class="block">
      <h4>修订留痕（原因 + 旧值 → 新值）</h4>
      <ul class="revision-list">
        <li v-for="revision in revisionsSorted" :key="revision.id">
          <p class="revision-head">
            <span>{{ fmtTime(revision.at) }}</span>
            <strong>原因：{{ revision.reason }}</strong>
          </p>
          <p v-for="(change, i) in revision.changes" :key="i" class="revision-change">
            {{ change.field }} · {{ change.target }}
            <template v-if="change.product"> · {{ change.product }}</template>
            ：{{ change.oldValue }} → {{ change.newValue }}
            <em v-if="change.diff">差额 {{ change.diff > 0 ? "+" : "" }}{{ formatNumber(change.diff) }}吨</em>
          </p>
        </li>
      </ul>
    </section>

    <!-- 核对冲突 -->
    <section v-if="conflicts.length" class="block">
      <h4 class="conflict-title">核对冲突（{{ conflicts.length }}）</h4>
      <table class="data-table conflict-table">
        <thead>
          <tr><th>层面</th><th>车牌/舱号</th><th>油品</th><th>应有</th><th>实际</th><th>差额</th></tr>
        </thead>
        <tbody>
          <tr v-for="(conflict, i) in conflicts" :key="i">
            <td>{{ conflict.scope }}</td>
            <td>{{ conflict.target }}</td>
            <td>{{ conflict.product || "—" }}</td>
            <td>{{ formatNumber(conflict.expected) }}</td>
            <td>{{ formatNumber(conflict.actual) }}</td>
            <td :class="conflict.diff > 0 ? 'diff-plus' : 'diff-minus'">
              {{ conflict.diff > 0 ? "+" : "" }}{{ formatNumber(conflict.diff) }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <p v-if="trip.note" class="note">{{ trip.note }}</p>

    <!-- 反馈信息 -->
    <div v-if="inlineIssues.length" class="issue-box">
      <p v-for="(issue, i) in inlineIssues" :key="i" class="issue error">✕ {{ issue.message }}</p>
    </div>
    <div v-if="inlineNotes.length" class="issue-box">
      <p v-for="(text, i) in inlineNotes" :key="i" class="issue warn">! {{ text }}</p>
    </div>

    <!-- 行程操作 -->
    <footer class="trip-actions">
      <button v-if="!trip.frozen" type="button" @click="emit('edit', trip)">编辑登记</button>
      <button v-if="!trip.frozen" type="button" @click="flash(store.depart(trip.id))">发车（冻结舱位顺序）</button>
      <button v-if="showOperations" type="button" @click="flash(store.advanceStop(trip.id))">
        {{ trip.currentStopIndex >= stops.length - 1 ? "完成到站" : `离开${currentStop?.station}，前往下一站` }}
      </button>

      <label v-if="trip.frozen" class="reason-input">
        重开本站原因
        <input v-model="reopenStopReason" placeholder="补录本站交付/退油必填原因" />
      </label>
      <button v-if="trip.frozen" type="button" class="secondary" @click="submitReopenStop">重开本站</button>

      <label v-if="trip.frozen && !trip.adjustUnlocked" class="reason-input">
        重开行程原因
        <input v-model="reopenTripReason" placeholder="调整舱位油品/顺序必填原因" />
      </label>
      <button v-if="trip.frozen && !trip.adjustUnlocked" type="button" class="secondary" @click="submitReopenTrip">
        重开行程
      </button>

      <button type="button" class="danger" @click="store.removeTrip(trip.id)">删除趟次</button>
    </footer>
  </article>
</template>
