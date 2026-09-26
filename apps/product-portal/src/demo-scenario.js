// Fixed, public synthetic material. No model calls or business writes are made by the demonstration.
export const scenario = {
  id: 'YUANYU-DEMO-01', version: '1.0', kind: 'synthetic-replay',
  question: '原料批次 RM-DEMO-01 出现异常，会影响哪些订单？',
  objects: [
    { id: 'raw', system: 'ERP', name: '原料批次', record: 'RM-DEMO-01', fact: '质量状态：待复核', source: 'ERP / material_batches / quality_status', note: '异常汇报不是已确认的质量事故。' },
    { id: 'production', system: 'MES', name: '生产批次', record: 'PB-DEMO-08', fact: '关联投料：RM-DEMO-01', source: 'MES / batch_inputs / material_batch_id', note: '使用投料记录关联，不按物料名称猜测。' },
    { id: 'inventory', system: 'WMS', name: '库存记录', record: 'INV-DEMO-12', fact: '账面数量：120 箱', source: 'WMS / inventory / production_batch_id', note: '库存数量不等于可售量，状态仍需核实。' },
    { id: 'order', system: 'OMS', name: '销售订单', record: 'SO-DEMO-26', fact: '分配数量：30 箱', source: 'OMS / allocations / inventory_id', note: '与库存通过分配记录关联，不能直接推断全部订单受损。' }
  ],
  steps: [
    { title: '准备材料', actor: '实施人员', state: '合成资料', heading: '先让字段拥有业务含义。', body: '输入需求、数据字典和接口说明，明确批次粒度、关联键和数量单位。原始数据仍由各业务系统管理。', detail: '输入：material_batches、batch_inputs、inventory、allocations 四类样本。数量口径统一为箱；不跨单位直接加总。', output: '产物：可追溯材料索引', evidence: '需求：查清异常批次的已知关联范围，而非自动冻结库存。' },
    { title: '生成候选', actor: '元域智语', state: '待校对', heading: '把系统字段连成业务关系。', body: '生成原料批次、生产批次、库存和订单候选。每条关系标明来源字段，让运营人员能逐项核对。', detail: '候选：原料批次 → 投料关系 → 生产批次 → 库存 → 分配关系 → 订单。候选不等于发布。', output: '产物：对象与关系草稿', evidence: 'MES.batch_inputs.material_batch_id → ERP.material_batches.id' },
    { title: '人工校对', actor: '建模人员', state: '人工判断', heading: '同名字段，不一定是同一件事。', body: '将“按物料名称关联”改为“按原料批次ID关联”，并保留一批多次投料的情况。', detail: '校对前：material_name → name。校对后：material_batch_id → id。关系基数：一个原料批次可对应多条投料记录。', output: '产物：已审阅差异', evidence: '为什么要改：相同物料名称下可能存在多个不同质量状态的批次。' },
    { title: '回放与发布', actor: '元域智语', state: '示例版本', heading: '先验证，再交给业务端。', body: '正常关联样本应返回路径；缺少分配关系的样本应保留缺口，而不是补出一个订单。', detail: '本页展示预设的正反例和示例版本 DEMO-v1，不在当前环境实际保存或发布模型。', output: '示例：已审阅模型 DEMO-v1', evidence: '反例：没有 allocations 记录时，订单影响为未知，不可归零或编造关联。' },
    { title: '智脑分析', actor: '业务智脑', state: '只读分析示例', heading: '回答有依据，影响有路径。', body: '在这组样本中，发现1条生产批次、1条库存和1条订单关联路径。库存账面120箱，订单分配30箱，两者不能重复加总。', detail: '未知项：是否还有其他仓库或分配记录、质量复核结论。此结论不是全企业的完整影响范围。', output: '产物：关联范围与证据缺口', evidence: '模型 DEMO-v1 · ERP → MES → WMS → OMS · 固定合成样本' },
    { title: '提出建议', actor: '业务人员确认', state: '尚未执行', heading: '分析之后，仍由人掌握决定权。', body: '建议先复核异常性质，再核对该库存对应的未发货分配。冻结、通知和订单调整需要各自的权限与确认。', detail: '本演示不会发送消息、发起审批、冻结库存或写入ERP。没有执行回执，不显示“任务完成”。', output: '产物：待确认处理建议', evidence: '必要确认：具体操作、目标对象、影响范围、操作者权限。' }
  ]
};
