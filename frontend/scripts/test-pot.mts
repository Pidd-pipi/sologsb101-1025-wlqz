/**
 * 锅次核销业务集成测试（node + fake-indexeddb，直接跑 ts 源需用 tsx/ts-node，
 * 这里改为用 esbuild 即时转译后执行）。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

// 让浏览器环境的全局对象就位
globalThis.structuredClone = globalThis.structuredClone ?? ((value: unknown) => JSON.parse(JSON.stringify(value)));

async function main() {
  const dbModule = await import('../src/utils/db.ts');
  const potUtil = await import('../src/utils/pot.ts');
  const { db, initDatabase, listRoastPots, listBlends, listRoastProfiles } = dbModule;

  await initDatabase();

  // 1) 播种后：guji / cerrado 已核销，house 定版生效占用；espresso 含作废锅 → 试配待替换
  let blends = await listBlends();
  const house = blends.find((b) => b.id === 'bl-house-01')!;
  const espresso = blends.find((b) => b.id === 'bl-espresso-02')!;
  const soe = blends.find((b) => b.id === 'bl-soe-04')!;
  assert.equal(house.state, 'final');
  assert.equal(house.pendingReplace, false);
  assert.equal(espresso.pendingReplace, true, 'espresso 含作废涅里锅，应待替换');
  assert.equal(soe.pendingReplace, false, 'SOE 小样占 guji 应全部生效');

  let pots = await listRoastPots();
  const gujiPot = pots.find((p) => p.profileId === 'rp-guji-500')!;
  const cerradoPot = pots.find((p) => p.profileId === 'rp-cerrado-1200')!;
  // house: guji 30%×1kg=0.3, cerrado 70%=0.7；soe: guji 0.05
  assert.ok(gujiPot.allocations.some((a) => a.blendId === 'bl-house-01' && a.state === 'active' && a.occupyKg === 0.3));
  assert.ok(cerradoPot.allocations.some((a) => a.blendId === 'bl-house-01' && a.state === 'active' && a.occupyKg === 0.7));
  assert.ok(gujiPot.allocations.some((a) => a.blendId === 'bl-soe-04' && a.state === 'active' && a.occupyKg === 0.05));
  // guji: 成品0.42 - 留样0.03 = 0.39; 已占 0.35; 剩 0.04
  const { availableKg, roundKg3 } = await import('../src/types/pot.ts');
  const gujiAvailable = roundKg3(0.42 - 0.03 - 0.35);
  assert.equal(Math.round(availableKg(gujiPot) * 1000) / 1000, gujiAvailable);

  // 2) 超卖拒绝：新建试配方案要占 guji 0.2kg（只剩 0.04）
  const { createId, nowIso, putBlend, reconcileAllocationsNow } = dbModule;
  const overBlend = {
    id: createId('bl'),
    name: '超卖测试方案',
    items: [{ greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 100 }],
    targetFlavor: '',
    targetBatchKg: 0.2,
    pendingReplace: false,
    createdAt: '2025-02-01',
    state: 'trial',
    updatedAt: nowIso(),
  };
  await putBlend(overBlend);
  await reconcileAllocationsNow();
  blends = await listBlends();
  const overAfter = blends.find((b) => b.id === overBlend.id)!;
  assert.equal(overAfter.pendingReplace, true, '容量不足必须转待替换');
  pots = await listRoastPots();
  const overAlloc = pots
    .find((p) => p.profileId === 'rp-guji-500')!
    .allocations.find((a) => a.blendId === overBlend.id)!;
  assert.equal(overAlloc.state, 'stale');
  // 已生效占用不受影响（不超卖）
  const activeSum = pots
    .find((p) => p.profileId === 'rp-guji-500')!
    .allocations.filter((a) => a.state === 'active')
    .reduce((acc, a) => acc + a.occupyKg, 0);
  assert.ok(activeSum <= 0.39 + 1e-6, '生效占用合计不得超过成品-留样');

  // 3) 杯测分数改动：把 guji 分数改到 85 以下 → 试配（soe）失效转待替换；定版 house 仍 final 只留提醒
  const { listCuppings, putCupping } = dbModule;
  const cuppings = await listCuppings();
  const gujiCp = cuppings.find((c) => c.profileId === 'rp-guji-500')!;
  const lowered = { ...gujiCp, dryAroma: 7, wetAroma: 7, acidity: 7, sweetness: 7, aftertaste: 7, totalScore: 70, updatedAt: nowIso() };
  await putCupping(lowered); // putCupping 内部触发对账
  blends = await listBlends();
  assert.equal(blends.find((b) => b.id === 'bl-soe-04')!.pendingReplace, true, '杯测改差后试配方案应待替换');
  assert.equal(blends.find((b) => b.id === 'bl-house-01')!.state, 'final', '已定版不因杯测改动下线');

  // 4) 杯测恢复后重新认领 soe
  const restored = { ...gujiCp, dryAroma: 8.5, wetAroma: 8.8, acidity: 8.6, sweetness: 8.9, aftertaste: 8.4, totalScore: 86.85, updatedAt: nowIso() };
  await putCupping(restored);
  const { reconfirmBlendNow } = dbModule;
  const reconfirm = await reconfirmBlendNow('bl-soe-04');
  assert.equal(reconfirm.ok, true, '杯测恢复且容量足够应能重新认领');
  // 再跑一次对账：已重认的方案不应反复回到待替换（签名已刷新）
  await reconcileAllocationsNow();
  blends = await listBlends();
  assert.equal(blends.find((b) => b.id === 'bl-soe-04')!.pendingReplace, false, '重认后再次对账不应反复失效');

  // 5) 定版门槛：soe 当前可定版；espresso（作废成分）不可定版
  const { checkBlendFinalizable } = potUtil;
  pots = await listRoastPots();
  const profiles = await listRoastProfiles();
  const allCuppings = await listCuppings();
  const soeReady = checkBlendFinalizable({
    blend: blends.find((b) => b.id === 'bl-soe-04')!,
    pots,
    profiles,
    cuppings: allCuppings,
  });
  assert.equal(soeReady.ok, true);
  const espressoBlocked = checkBlendFinalizable({
    blend: blends.find((b) => b.id === 'bl-espresso-02')!,
    pots,
    profiles,
    cuppings: allCuppings,
  });
  assert.equal(espressoBlocked.ok, false);

  // 6) 机台当天容量排队：HB-M6 容量 1000g，day(2) 已有 500g；新建 600g 应排队
  const { createId: cid, putRoastProfile, applyScheduleForProfile } = dbModule;
  const queuedProfile = {
    id: cid('rp'),
    greenBeanId: 'gb-guji-washed',
    machineModel: 'HB-M6',
    chargeG: 540,
    chargeTempC: 200,
    airflow: 'half',
    gasLevel: 4,
    roastedAt: '2025-01-12', // day(2) from seed base 2025-01-10
    state: 'recording',
    scheduleStatus: 'scheduled',
    queueOrder: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await putRoastProfile(queuedProfile);
  const schedule = await applyScheduleForProfile(queuedProfile);
  assert.equal(schedule, 'queued', '540g + 500g > 1000g 应排队');
  // 排队中不允许完成核销
  const { verifyRoastPot, updateRoastState } = dbModule;
  await assert.rejects(
    () => updateRoastState(queuedProfile.id, 'done'),
    /排队/,
  );
  const verifyQueued = await verifyRoastPot(queuedProfile.id, { productKg: 0.45, sampleKg: 0.02, lossKg: 0.07 });
  assert.equal(verifyQueued.ok, false);
  // 作废已排产的 guji 释放容量后，排队批次自动递补
  await updateRoastState('rp-guji-500', 'void');
  const afterAdmit = await listRoastProfiles();
  assert.equal(afterAdmit.find((p) => p.id === queuedProfile.id)!.scheduleStatus, 'scheduled', '容量释放后应自动递补');

  // 7) 旧数据补认：构造无锅次来源的方案（profileId 指向不存在记录），同日同豆源唯一锅可补认
  const legacyBlend = {
    id: 'bl-legacy',
    name: '旧数据方案',
    items: [{ greenBeanId: 'gb-cerrado-natural', profileId: 'rp-deleted-xxx', ratioPct: 100 }],
    targetFlavor: '',
    targetBatchKg: 0.1,
    pendingReplace: false,
    createdAt: '2025-01-20', // = cerrado roastedAt day(10)
    state: 'trial',
    updatedAt: nowIso(),
  };
  await putBlend(legacyBlend);
  const { recognizeLegacyBlendItems } = potUtil;
  const allProfiles = await listRoastProfiles();
  const allBlends = await listBlends();
  const rec = recognizeLegacyBlendItems({ blends: allBlends, profiles: allProfiles });
  const fixed = rec.blends.find((b) => b.id === 'bl-legacy')!;
  assert.equal(fixed.items[0].profileId, 'rp-cerrado-1200', '应按豆源+日期补认到唯一锅次');

  console.log('全部业务断言通过 ✅');
  void db;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
