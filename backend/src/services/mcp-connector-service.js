const connectorCatalog = [
  { id: 'mcp-oa', name: 'OA / BPM', system: 'OA', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://identity/oa-service-principal', classification: '组织与审批受限', domains: ['internal'], objects: ['Person', 'Approval', 'Task'], tools: ['read_approval_context'], writeMode: 'approval_required' },
  { id: 'mcp-erp', name: 'ERP 供应与库存', system: 'ERP', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/erp-read-write', classification: '供应链受限', domains: ['production', 'internal'], objects: ['RawMaterial', 'Product', 'Supplier', 'Budget'], tools: ['read_inventory', 'create_procurement_draft'], writeMode: 'draft_and_approval' },
  { id: 'mcp-wms', name: 'WMS 仓储与物流', system: 'WMS', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/wms-readonly', classification: '仓储运营受限', domains: ['production', 'internal'], objects: ['InventoryLot', 'Warehouse', 'InboundReceipt', 'OutboundShipment'], tools: ['read_inventory_lot', 'read_inbound_receipt'], writeMode: 'read_only' },
  { id: 'mcp-mes', name: 'MES 生产执行', system: 'MES', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/mes-readonly', classification: '生产受限', domains: ['production'], objects: ['Equipment', 'Product', 'ProductionBatch'], tools: ['read_production_plan', 'read_equipment_status'], writeMode: 'read_only' },
  { id: 'mcp-lims', name: 'LIMS 质量实验室', system: 'LIMS', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/lims-readonly', classification: '质量受限', domains: ['production'], objects: ['RawMaterial', 'Product', 'QualityRecord'], tools: ['read_release_status', 'read_coa'], writeMode: 'read_only' },
  { id: 'mcp-qms', name: 'QMS 质量管理', system: 'QMS', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/qms-readonly', classification: '质量受限', domains: ['production'], objects: ['CAPA', 'ChangeControl', 'QualityEvent'], tools: ['read_capa_status', 'read_quality_event'], writeMode: 'read_only' },
  { id: 'mcp-oms', name: 'OMS 订单与门店运营', system: 'OMS', status: 'connected_demo', transport: 'MCP over HTTPS', credentialRef: 'kms://integration/oms-desensitized', classification: '订单与门店运营受限', domains: ['marketing'], objects: ['Store', 'Order', 'Fulfillment', 'ReturnOrder'], tools: ['read_store_status', 'read_order_fulfillment'], writeMode: 'read_only' }
];

const roleDomains = {
  executive: ['production', 'marketing', 'internal'],
  quality_manager: ['production'],
  production_manager: ['production'],
  procurement_manager: ['production', 'internal'],
  marketing_manager: ['marketing']
};

export function getMcpConnectors(roleId) {
  const allowedDomains = roleDomains[roleId] || [];
  return {
    protocol: 'MCP',
    policy: '所有连接器调用均由智脑服务主体代发；连接器不向终端暴露密钥，写入动作必须先通过元对象、业务权限和审批门禁。',
    connectors: connectorCatalog.map((connector) => ({
      ...connector,
      accessible: connector.domains.some((domain) => allowedDomains.includes(domain)),
      visibleTools: connector.domains.some((domain) => allowedDomains.includes(domain)) ? connector.tools : [],
      credentialMode: 'short_lived_lease',
      leasePolicy: getKeyLeasePolicyForConnector(connector.id)
    }))
  };
}
import { getKeyLeasePolicyForConnector } from './key-center/key-center-service.js';
