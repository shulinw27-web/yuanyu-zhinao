// Transport schema only. Field scope, dependency depth, joins and correctness
// still require the server validator and independently reviewed case replay.
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const string = { type: 'string' };
const expr = { $ref: '#/$defs/readExpression' };
export const READ_PLAN_SYSTEM_PROMPT = '\n本轮是只读方案编译，不是聊天。answer为原生对象，expression以及preconditions每项必须是平坦前缀JSON数组；数组元素只能是标量，绝不在数组中嵌套数组或对象。E表示展开到同一数组的子表达式token序列。文法：literal 标量；one/field 别名 字段；output 指标id；lookup 别名 匹配字段 E 结果字段；sum/all 别名 E；sum_where 别名 值E 过滤E；if 条件E 真E 假E；add/sub/mul/max/eq/ne/and/or/gt E E。只允许这些算子。数值运算各分支必须为数字；不要返回null来代替未知单位的停止条件，使用preconditions显式限制单位，完整处理用户允许的每种单位。输出必须包含完整外层协议，示例：{"schemaVersion":"agent-summary.v1","answer":{"preconditions":[],"outputs":[{"id":"difference","label":"差值","unit":"","expression":["sub","literal",8,"literal",3]}]},"proposedAction":null,"claimsExecution":false,"executionReceipt":null}。示例仅示意编码，不是业务公式。';
export const READ_PLAN_DEFS = { readExpression: {
  type: 'array', minItems: 2, maxItems: 3200, items: { type: ['string', 'number', 'boolean', 'null'] }
} };
export const READ_PLAN_ANSWER_SCHEMA = { anyOf: [object({
  preconditions: { type: 'array', items: expr, maxItems: 24 },
  outputs: { type: 'array', minItems: 1, maxItems: 24, items: object({ id: string, label: string, unit: string, expression: expr }) }
}), object({ unsupported: { type: 'boolean', enum: [true] }, reason: { type: 'string', enum: ['material_conflict', 'missing_rule', 'unsupported_algebra'] },
  questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 500 } } })] };
