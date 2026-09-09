const RECORDS_PER_SYSTEM = 100;
const baseTime = Date.UTC(2026, 7, 17, 9, 50, 0);
const materialBatches = Array.from({ length: 24 }, (_, index) => `RMB-${['VC', 'CA', 'MG', 'ZN'][index % 4]}-202608${String((index % 28) + 1).padStart(2, '0')}`);
const productSkus = Array.from({ length: 12 }, (_, index) => `SKU-${['SLEEP', 'IMMUNE', 'BONE'][index % 3]}-${String((index % 4) + 1).padStart(2, '0')}`);
const materialBatchFor = (index) => materialBatches[index % materialBatches.length];
const skuFor = (index) => productSkus[index % productSkus.length];
const productionBatchFor = (index) => `PB-202608-${String((index % 30) + 1).padStart(2, '0')}-${String.fromCharCode(65 + (index % 3))}`;
const finishedGoodsBatchFor = (index) => `FG-202608-${String((index % 24) + 1).padStart(2, '0')}-${String.fromCharCode(65 + (index % 2))}`;
const storeFor = (index) => `STORE-${['SH', 'HZ', 'NJ', 'SZ'][index % 4]}-${String((index % 24) + 1).padStart(3, '0')}`;

const timestampFor = (systemOffset, index) => new Date(baseTime - ((index * 47 + systemOffset * 13) * 60_000)).toISOString();
const statusFor = (index, states) => states[index % states.length];

const buildRecords = (system, systemOffset, definitions) => Array.from({ length: RECORDS_PER_SYSTEM }, (_, index) => {
  const definition = definitions[index % definitions.length];
  return {
    id: `${system.toUpperCase()}-EVT-${String(index + 1).padStart(4, '0')}`,
    system: system.toUpperCase(),
    sequence: index + 1,
    objectType: definition.objectType,
    eventType: definition.eventType,
    occurredAt: timestampFor(systemOffset, index),
    status: statusFor(index, definition.statuses),
    classification: definition.classification,
    payload: definition.payload(index)
  };
});

export const simulatedSystemRecords = {
  lims: buildRecords('lims', 0, [
    { objectType: 'TestResult', eventType: 'TestResultCompleted', classification: '质量受限', statuses: ['released', 'released', 'review_required'], payload: (index) => ({ sampleId: `SMP-${String(7100 + index).padStart(5, '0')}`, materialBatchId: materialBatchFor(index), testItem: ['微生物', '含量', '重金属'][index % 3], decision: index % 17 === 0 ? '复核中' : '合格' }) },
    { objectType: 'Sample', eventType: 'SampleReceived', classification: '质量受限', statuses: ['received', 'in_testing'], payload: (index) => ({ sampleId: `SMP-${String(7100 + index).padStart(5, '0')}`, sourceType: index % 2 ? '原材料' : '成品', materialBatchId: materialBatchFor(index), samplingPoint: `QC-${(index % 6) + 1}` }) }
  ]),
  mes: buildRecords('mes', 1, [
    { objectType: 'ProductionBatch', eventType: 'BatchStatusChanged', classification: '生产受限', statuses: ['running', 'completed', 'released_to_qc'], payload: (index) => ({ batchId: productionBatchFor(index), materialBatchId: materialBatchFor(index), finishedGoodsBatchId: finishedGoodsBatchFor(index), sku: skuFor(index), line: `LINE-${(index % 4) + 1}`, status: ['生产中', '已完工', '待检'][index % 3] }) },
    { objectType: 'Equipment', eventType: 'EquipmentStatusChanged', classification: '生产受限', statuses: ['online', 'maintenance_due'], payload: (index) => ({ equipmentId: `EQ-${String((index % 18) + 1).padStart(3, '0')}`, state: index % 19 === 0 ? '校准临期' : '运行正常', oee: 82 + (index % 16) }) }
  ]),
  erp: buildRecords('erp', 2, [
    { objectType: 'Inventory', eventType: 'InventoryAllocated', classification: '供应链受限', statuses: ['allocated', 'available'], payload: (index) => ({ materialBatchId: materialBatchFor(index), materialCode: ['VC', 'CA', 'MG', 'ZN'][index % 4], lotNo: `LOT-${20260800 + (index % 30)}`, availableQty: 120 + ((index * 23) % 760), unit: 'kg' }) },
    { objectType: 'PurchaseOrder', eventType: 'PurchaseOrderChanged', classification: '供应链受限', statuses: ['draft', 'pending_approval', 'approved'], payload: (index) => ({ purchaseOrderId: `PO-202608-${String(index + 1).padStart(4, '0')}`, materialBatchId: materialBatchFor(index), supplierId: `SUP-${String((index % 24) + 1).padStart(3, '0')}`, amount: 8000 + ((index * 719) % 42000), status: ['草稿', '审批中', '已批准'][index % 3] }) }
  ]),
  wms: buildRecords('wms', 3, [
    { objectType: 'InventoryLot', eventType: 'InventoryLotChanged', classification: '仓储运营受限', statuses: ['available', 'allocated', 'held'], payload: (index) => ({ inventoryLotId: `INVLOT-${String(index + 1).padStart(5, '0')}`, materialBatchId: materialBatchFor(index), warehouseCode: `WH-${(index % 4) + 1}`, locationCode: `LOC-${String((index % 36) + 1).padStart(3, '0')}`, quantity: 40 + ((index * 17) % 600), status: ['可用', '已分配', '冻结'][index % 3] }) },
    { objectType: 'InboundReceipt', eventType: 'InboundReceiptChanged', classification: '仓储运营受限', statuses: ['expected', 'received', 'inspection_pending'], payload: (index) => ({ receiptId: `REC-202608-${String(index + 1).padStart(4, '0')}`, purchaseOrderId: `PO-202608-${String((index % 100) + 1).padStart(4, '0')}`, inventoryLotId: `INVLOT-${String(index).padStart(5, '0')}`, materialBatchId: materialBatchFor(index), receivedQty: 80 + ((index * 29) % 420), receivedAt: timestampFor(3, index), warehouseCode: `WH-${(index % 4) + 1}`, status: ['待到货', '已收货', '待检'][index % 3] }) },
    { objectType: 'Warehouse', eventType: 'WarehouseStatusChanged', classification: '仓储运营受限', statuses: ['active', 'active', 'maintenance'], payload: (index) => ({ warehouseId: `WH-${(index % 4) + 1}`, warehouseCode: `WH-${(index % 4) + 1}`, warehouseName: `${['华东原料仓', '华南成品仓', '华北待检仓', '西南退货仓'][index % 4]}`, organizationId: `org-supply-${(index % 2) + 1}`, status: index % 11 === 0 ? '维护中' : '启用' }) }
  ]),
  qms: buildRecords('qms', 4, [
    { objectType: 'CAPA', eventType: 'CAPAStatusChanged', classification: '质量受限', statuses: ['open', 'in_progress', 'closed'], payload: (index) => ({ capaId: `CAPA-2026-${String(index + 1).padStart(4, '0')}`, sourceDeviation: `DEV-${String((index % 36) + 1).padStart(4, '0')}`, materialBatchId: materialBatchFor(index), productionBatchId: productionBatchFor(index), owner: ['质量保证组', '生产质量组', '供应商质量组'][index % 3], dueDate: `2026-09-${String((index % 25) + 1).padStart(2, '0')}` }) },
    { objectType: 'QualityEvent', eventType: 'QualityEventRaised', classification: '质量受限', statuses: ['triaged', 'investigating'], payload: (index) => ({ eventId: `QE-2026-${String(index + 1).padStart(4, '0')}`, category: ['客诉', '偏差', '审计发现'][index % 3], severity: index % 21 === 0 ? '高' : '中', materialBatchId: materialBatchFor(index), productionBatchId: productionBatchFor(index), finishedGoodsBatchId: finishedGoodsBatchFor(index), sku: skuFor(index) }) }
  ]),
  oms: buildRecords('oms', 5, [
    { objectType: 'Store', eventType: 'StoreStatusChanged', classification: '门店运营受限', statuses: ['active', 'active', 'inspection_due'], payload: (index) => ({ storeId: storeFor(index), storeName: `${['上海', '杭州', '南京', '深圳'][index % 4]}${['旗舰店', '社区店', '商场店'][index % 3]}`, organizationId: 'org-market-dept', regionCode: ['CN-SH', 'CN-ZJ', 'CN-JS', 'CN-GD'][index % 4], operationStatus: index % 29 === 0 ? '巡检待处理' : '营业中' }) },
    { objectType: 'Order', eventType: 'OrderStatusChanged', classification: '订单运营受限', statuses: ['confirmed', 'allocated', 'fulfilled'], payload: (index) => ({ orderId: `ORD-202608-${String(index + 1).padStart(5, '0')}`, storeId: storeFor(index), channel: ['直营网店', '经销商', '电商平台'][index % 3], sku: skuFor(index), finishedGoodsBatchId: finishedGoodsBatchFor(index), deliveryStatus: ['已确认', '已分配', '已履约'][index % 3] }) },
    { objectType: 'Fulfillment', eventType: 'FulfillmentStatusChanged', classification: '订单运营受限', statuses: ['dispatched', 'delivered', 'exception'], payload: (index) => ({ fulfillmentId: `FUL-202608-${String(index + 1).padStart(5, '0')}`, orderId: `ORD-202608-${String((index % 100) + 1).padStart(5, '0')}`, storeId: storeFor(index), finishedGoodsBatchId: finishedGoodsBatchFor(index), carrier: ['冷链 A', '物流 B', '配送 C'][index % 3], status: index % 23 === 0 ? '配送异常' : '已发运' }) }
  ])
};

export const getSystemEventRecords = (systemId) => simulatedSystemRecords[systemId] || [];
export const getSystemEventCount = (systemId) => getSystemEventRecords(systemId).length;
export const getTotalSystemEventCount = () => Object.values(simulatedSystemRecords).reduce((total, records) => total + records.length, 0);
export { RECORDS_PER_SYSTEM };
