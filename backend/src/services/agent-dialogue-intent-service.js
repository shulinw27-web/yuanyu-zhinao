import { affirmativeRequest } from './agent-turn-understanding-service.js';
// These are dialogue acts, not grants to read data or execute prior proposals.
export const isExplanationFollowUp = input => /^(?:请|麻烦|能不能|可以)?\s*(?:这(?:个)?(?:是)?什么意思|那(?:个)?(?:是)?什么意思|什么意思|我(?:没懂|不明白|没看懂)|解释(?:一下|下)?(?:刚才|上面|上一句|你的回复)?|(?:刚才|上面|上一句|你说的)(?:是)?什么意思|说人话)[。！!？?\s]*$/u.test(String(input).trim());

export const isLongTermGoalStatement = input => /^(?:我的?|我们(?:的)?)(?:长期|阶段|工作)目标是/u.test(String(input).trim())
  && /只(?:讨论|记录|说明)|不(?:执行|查询|读取)|先(?:讨论|记录)/u.test(String(input))
  && !/(?:现在|立即|同时|顺便|请|帮我).{0,12}(?:查询|读取|执行|发起|创建|分析)/u.test(affirmativeRequest(input));

export const isBroadReportRequest = input => /报告|报表|汇总/u.test(affirmativeRequest(input))
  && /ERP|WMS|MES|QMS|OA|经营|库存|采购|销售|财务|生产/iu.test(affirmativeRequest(input));

export function dialogueFallback({ explanation, report, history, priorGoal }) {
  if (explanation) {
    if (/历史快照|ISO|跨来源最新/u.test(history)) return '刚才的意思是：我还不能保证拿到各个系统最新的数据。不过，让你提供 ISO 时间来索要普通报告并不合适。我们可以先明确报告范围，再检查数据来源和更新时间。你需要综合报告，还是采购、库存等专项报告？本次没有读取系统数据或生成报告。';
    if (/模型端点|模型服务|降级/u.test(history)) return '刚才没有获得模型的有效回答，所以显示了备用提示，不代表你的问题已经解决。你的问题和当前会话仍然保留，可以重试；本次没有读取企业数据或执行操作。';
    return history ? `你是在问上一条回复，而不是提出一个新任务。当前讨论的是“${String(priorGoal || '上一条回复').slice(0, 180)}”。暂时无法生成进一步解释，请重试；没有执行新的业务操作。` : '你是在问我上一句话的意思吗？当前没有可用的上一条回复，请指出需要解释的部分；不需要重新描述整个任务。';
  }
  if (report) return '可以先整理报告需求。你想看综合概览，还是采购、库存、销售等专项？我会在明确范围后检查可访问的数据来源与更新时间；如果只有模拟数据，会明确标注，不当作真实最新报告。本次尚未读取数据或生成报告。';
  return null;
}
