// 受控连接器目录。
//
// 目录成员与属性已收敛到唯一事实源（data/system-catalog.js）；本文件只负责
// 「按角色数据域裁剪可见性」这一层策略，不再自行维护系统清单。
// 历史问题：此处曾硬编码 7 个连接器，与 seed.js 的 6 个系统、systemAliases 的 12 个
// 系统互不一致，且 OA 在此为 connected_demo、在连接目标中为「待接入」。
// 现在 connector.status（受控连接器目录登记状态）与 onboardingStatus（租户接入进度）
// 是两个明确分离的轴，见 system-catalog.js 的注释。
import { getSystemDefinitions, getRoleDataDomains } from './system-registry-service.js';
import { getKeyLeasePolicyForConnector } from './key-center/key-center-service.js';

const connectorCatalog = getSystemDefinitions()
  .filter((item) => item.connector)
  .map((item) => ({
    id: item.connector.id,
    name: item.connector.displayName,
    system: item.code,
    status: item.connector.status,
    transport: item.connector.transport,
    credentialRef: item.connector.credentialRef,
    classification: item.connector.classification,
    domains: [...item.connector.dataDomains],
    objects: [...item.connector.objects],
    tools: [...item.connector.tools],
    writeMode: item.connector.writeMode
  }));

export function getMcpConnectors(roleId) {
  const allowedDomains = getRoleDataDomains(roleId);
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
