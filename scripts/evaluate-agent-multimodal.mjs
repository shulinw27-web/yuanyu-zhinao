// Real-model acceptance with synthetic fixtures. Never point this scanner stub
// at the application: it accepts only exact hashes of these generated fixtures.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = 'ark'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
process.env.MULTIMODAL_VISUAL_PROVIDER = 'model';
process.env.AGENT_EXTERNAL_MULTIMODAL_MODE = 'approved';
process.env.MULTIMODAL_CONTENT_SECURITY_MODE = 'required';
delete process.env.MULTIMODAL_OCR_ENDPOINT;
loadArkFileConfig();
const cases = [
  ['dictionary.json', 'application/json', '字段'],
  ['dictionary.yaml', 'application/yaml', '字段'],
  ['dictionary.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '字段'],
  ['tickets.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '表格'],
  ['tickets.csv', 'text/csv', '表格'],
  ['relationship.png', 'image/png', '图片'],
  ['relationship.jpg', 'image/jpeg', '图片'],
  ['relationship.webp', 'image/webp', '图片'],
  ['scanned-model.pdf', 'application/pdf', '图片'],
  ['mixed-report.pdf', 'application/pdf', '混合PDF']
].map(([name, mimeType, kind]) => ({ name, mimeType, kind, bytes: readFileSync(`output/multimodal-fixtures/${name}`) }));
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = new Set(cases.map(item => fingerprint(item.bytes)));
let scans = 0;
const scanner = createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body); const clean = allowed.has(fingerprint(Buffer.from(payload.contentBase64, 'base64')));
    scans += 1; res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clean, dlpAction: clean ? 'allow' : 'block', scanId: 'synthetic-exact-fixture-only' }));
  });
});
await new Promise(resolve => scanner.listen(0, '127.0.0.1', resolve));
process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT = `http://127.0.0.1:${scanner.address().port}`;
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { createAgentConversation, getAgentConversationContext, recordAgentConversationExchange } = await import('../backend/src/services/agent-conversation-service.js');
const { createSemanticOperationsTask } = await import('../backend/src/services/semantic-operations-task-service.js');
const { extractMultimodalEvidence, inspectMultimodalInput } = await import('../backend/src/services/multimodal-input-service.js');
const role = getRole('executive');
const results = [];
const selected = process.argv.slice(2);
try {
  for (const item of cases.filter(item => !selected.length || selected.includes(item.name))) {
    const attachment = { name: item.name, mimeType: item.mimeType, dataUrl: `data:${item.mimeType};base64,${item.bytes.toString('base64')}` };
    if (process.env.MULTIMODAL_PROPOSAL_ONLY === 'true') {
      const task = await createSemanticOperationsTask({ body: { text: '根据附件中的 Asset 和 RepairTicket 字典形成候选语义模型供我校对，主键和外键必须按附件，不保存草稿、不发布。', attachments: [attachment] }, role, identityScope: { tenantId: 'demo-enterprise', subjectId: 'synthetic-mm-build', deviceId: 'synthetic-mm-build' } });
      const objects = task.proposal?.objectTypes || [];
      const repair = objects.find(object => object.id === 'RepairTicket');
      const passed = task.status === 'waiting_confirmation' && repair?.key === 'ticket_code' && objects.some(object => object.id === 'Asset') && task.proposal.relationshipTypes.some(relation => relation.from === 'RepairTicket' && relation.to === 'Asset');
      const result = { file: item.name, surface: 'semantic_proposal', passed, status: task.status, answer: task.response || task.error, objects, relationships: task.proposal?.relationshipTypes };
      results.push(result); console.log(JSON.stringify(result)); continue;
    }
    if (process.env.MULTIMODAL_EXTRACT_ONLY === 'true') {
      const content = await extractMultimodalEvidence(inspectMultimodalInput({ attachments: [attachment] }, role).attachments);
      console.log(JSON.stringify({ file: item.name, reports: content.reports, text: content.modelContext }));
      continue;
    }
    for (const surface of ['brain', 'semantic']) {
      const identity = { tenantId: 'demo-enterprise', subjectId: `synthetic-mm-${surface}-${item.name}`, deviceId: 'synthetic-mm-evaluation' };
      const conversation = surface === 'brain' ? await createAgentConversation({ roleId: role.id, identityScope: identity }) : null;
      const queries = item.kind === '字段'
        ? ['只解释附件内容，不读取系统，不建模、不保存、不发布。RepairTicket 的主键和金额字段分别叫什么？', '继续只讨论刚才附件。把刚才的两个字段名再列出来，并说明哪个是主键。']
        : ['只分析附件，不读取系统、不建模、不生成文件、不发布。RT-101 对应哪项资产编号，维修金额是多少，单位是什么？', item.kind === '表格' || item.kind === '混合PDF' ? '继续只讨论刚才的附件。RT-102 金额是多少？两笔维修金额合计多少？' : '继续只讨论刚才的图。Asset 和 RepairTicket 之间用哪个字段关联？是一对多还是一对一？'];
      let parent;
      for (const [turn, query] of queries.entries()) {
        const started = Date.now();
        let answer; let source; let command;
        if (surface === 'brain') {
          const context = await getAgentConversationContext(conversation.id, identity);
          const response = await runPrivateAgent({ text: query, ...(turn === 0 ? { attachments: [attachment] } : {}) }, role, identity, { conversationContext: context });
          answer = response.text; source = response.agent.inferenceSource; command = response.command;
          await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: role.id, userText: query, response });
        } else {
          const task = await createSemanticOperationsTask({ body: { text: query, ...(turn === 0 ? { attachments: [attachment] } : { parentTaskId: parent.id }) }, role, identityScope: identity });
          answer = task.response || task.error; source = task.routing?.source; command = task.command; parent = task;
        }
        const facts = item.kind === '字段' ? /ticket_code/.test(answer) && /repair_cost/.test(answer)
          : turn === 0 ? /AS-01/.test(answer) && /137\.5/.test(answer) && /CNY|元|人民币/.test(answer)
            : item.kind === '表格' || item.kind === '混合PDF' ? /22\.5/.test(answer) && /160/.test(answer)
              : /asset_code/.test(answer) && /一对多|1\s*[:：]\s*[nN多]|0\.\.n/.test(answer);
        const passed = source === 'ark' && !command && facts && !/\bCY\b/.test(answer);
        results.push({ file: item.name, surface, turn: turn + 1, passed, source, command: command || null, ms: Date.now() - started, answer });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  }
} finally { await new Promise(resolve => scanner.close(resolve)); }
console.log(JSON.stringify({ type: 'summary', passed: results.filter(item => item.passed).length, total: results.length, scans, scanner: 'synthetic exact-hash stub, NOT production AV/DLP', failures: results.filter(item => !item.passed).map(({ file, surface, turn }) => ({ file, surface, turn })) }));
process.exitCode = results.every(item => item.passed) ? 0 : 1;
