import { randomUUID } from 'node:crypto';

const iso = (value = Date.now()) => new Date(value).toISOString();
const bounded = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
};
const workerIdOf = (value) => {
  const workerId = String(value || '').trim().slice(0, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/u.test(workerId)) throw new Error('Worker id is invalid.');
  return workerId;
};
const normalizeIdentity = (identity = {}) => ({
  tenantId: String(identity.tenantId || '').slice(0, 120), subjectId: String(identity.subjectId || '').slice(0, 180),
  sessionId: String(identity.sessionId || '').slice(0, 180), deviceId: String(identity.deviceId || '').slice(0, 180)
});
const taskError = (message, code) => ({ error: message, code });
const mapTask = (row) => row ? ({
  id: row.task_id,
  type: row.task_type,
  runId: row.run_id,
  commandId: row.command_id,
  conversationId: row.conversation_id,
  roleId: row.role_id,
  identityScope: { tenantId: row.tenant_id, subjectId: row.subject_id, sessionId: row.session_id, deviceId: row.device_id },
  status: row.status,
  phase: row.phase,
  attempt: Number(row.attempt),
  progress: Number(row.progress),
  deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : null,
  pauseExpiresAt: row.pause_expires_at ? new Date(row.pause_expires_at).toISOString() : null,
  remainingTimeoutMs: row.remaining_timeout_ms === null ? null : Number(row.remaining_timeout_ms),
  leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
  dispatchId: row.dispatch_id,
  result: row.result_json,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  version: Number(row.version)
}) : null;

export class PostgresAgentLongTaskRepository {
  constructor({ pool, clock = Date.now } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL agent runtime repository requires a pg-compatible Pool.');
    this.pool = pool;
    this.clock = clock;
  }

  async initialize() {
    const result = await this.pool.query('SELECT version FROM platform_schema_migrations ORDER BY version');
    const latest = Number(result.rows.at(-1)?.version || 0);
    if (latest < 3) throw new Error('PostgreSQL agent runtime schema is not initialized. Run migrate:postgres first.');
    if (latest > 5) throw new Error(`PostgreSQL agent runtime schema ${latest} is newer than supported version 5.`);
    return { driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 3 };
  }

  async getTask(taskId) {
    const result = await this.pool.query('SELECT * FROM agent_long_tasks WHERE task_id=$1', [String(taskId || '').slice(0, 160)]);
    return mapTask(result.rows[0]);
  }

  async listTasks({ roleIds, identityScope, nowAt = this.clock(), limit = 30 }) {
    await this.expireDueTasks({ nowAt });
    const identity = normalizeIdentity(identityScope);
    const roles = [...new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean).map(String))];
    if (![identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId].every(Boolean) || !roles.length) return [];
    const result = await this.pool.query(`
      SELECT * FROM agent_long_tasks
      WHERE tenant_id=$1 AND subject_id=$2 AND session_id=$3 AND device_id=$4 AND role_id=ANY($5::text[])
      ORDER BY updated_at DESC LIMIT $6
    `, [identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId, roles, bounded(limit, 30, 1, 100)]);
    return result.rows.map(mapTask);
  }

  async controlTask({ taskId, roleId, identityScope, action, nowAt = this.clock(), maxPauseMs = 1_800_000, timeoutMs = 600_000 }) {
    const identity = normalizeIdentity(identityScope);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = await client.query(`SELECT * FROM agent_long_tasks WHERE task_id=$1 AND role_id=$2 AND tenant_id=$3 AND subject_id=$4 AND session_id=$5 AND device_id=$6 FOR UPDATE`, [taskId, roleId, identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId]);
      if (!scoped.rowCount) { await client.query('ROLLBACK'); return taskError('未找到当前会话和设备可控制的长任务。', 'AGENT_LONG_TASK_NOT_FOUND'); }
      const task = scoped.rows[0];
      let result;
      if (action === 'pause') {
        if (task.status !== 'queued') { await client.query('ROLLBACK'); return taskError('只有排队中的任务可以暂停。', 'AGENT_LONG_TASK_NOT_PAUSABLE'); }
        const remaining = Math.max(1_000, Date.parse(task.deadline_at) - Number(nowAt));
        result = await client.query(`UPDATE agent_long_tasks SET status='paused',phase='paused_by_user',remaining_timeout_ms=$2,pause_expires_at=$3,deadline_at=NULL,updated_at=$4,version=version+1 WHERE task_id=$1 RETURNING *`, [taskId, remaining, iso(Number(nowAt) + Math.min(remaining, maxPauseMs)), iso(nowAt)]);
      } else if (action === 'resume') {
        if (task.status !== 'paused') { await client.query('ROLLBACK'); return taskError('只有已暂停任务可以恢复。', 'AGENT_LONG_TASK_NOT_RESUMABLE'); }
        result = await client.query(`UPDATE agent_long_tasks SET status='queued',phase='waiting_for_worker',deadline_at=$2,pause_expires_at=NULL,remaining_timeout_ms=NULL,updated_at=$3,version=version+1 WHERE task_id=$1 RETURNING *`, [taskId, iso(Number(nowAt) + Math.max(1_000, Number(task.remaining_timeout_ms) || timeoutMs)), iso(nowAt)]);
      } else if (action === 'cancel') {
        if (!['queued', 'paused'].includes(task.status)) { await client.query('ROLLBACK'); return taskError('任务已经开始派发，不能再安全取消。', 'AGENT_LONG_TASK_NOT_CANCELLABLE'); }
        result = await client.query(`UPDATE agent_long_tasks SET status='cancelled',phase='cancelled_by_user',progress=100,result_json=$2::jsonb,updated_at=$3,version=version+1 WHERE task_id=$1 RETURNING *`, [taskId, JSON.stringify({ code: 'AGENT_LONG_TASK_CANCELLED', message: '用户已取消，未派发端侧操作。' }), iso(nowAt)]);
      } else { await client.query('ROLLBACK'); return taskError('不支持的长任务控制动作。', 'AGENT_LONG_TASK_ACTION_INVALID'); }
      await client.query('COMMIT');
      return { task: mapTask(result.rows[0]) };
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* preserve original error */ } throw error; } finally { client.release(); }
  }

  async claimTask({ taskId, roleId, identityScope, nowAt = this.clock(), leaseMs = 180_000 }) {
    const identity = normalizeIdentity(identityScope);
    const result = await this.pool.query(`
      UPDATE agent_long_tasks SET status='running',phase='worker_claimed',attempt=attempt+1,progress=10,lease_expires_at=$7,updated_at=$8,version=version+1
      WHERE task_id=$1 AND role_id=$2 AND tenant_id=$3 AND subject_id=$4 AND session_id=$5 AND device_id=$6 AND status='queued' AND deadline_at>$8
      RETURNING *
    `, [taskId, roleId, identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId, iso(Number(nowAt) + bounded(leaseMs, 180_000, 30_000, 600_000)), iso(nowAt)]);
    if (result.rowCount) return { task: mapTask(result.rows[0]) };
    const scoped = await this.pool.query(`SELECT status FROM agent_long_tasks WHERE task_id=$1 AND role_id=$2 AND tenant_id=$3 AND subject_id=$4 AND session_id=$5 AND device_id=$6`, [taskId, roleId, identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId]);
    return scoped.rowCount ? taskError('任务不处于可领取的排队状态。', 'AGENT_LONG_TASK_NOT_CLAIMABLE') : taskError('未找到当前会话和设备可领取的长任务。', 'AGENT_LONG_TASK_NOT_FOUND');
  }

  async markDispatched(taskId, dispatch, nowAt = this.clock()) {
    const result = await this.pool.query(`UPDATE agent_long_tasks SET phase='endpoint_dispatched',progress=50,dispatch_id=$2,lease_expires_at=$3,updated_at=$4,version=version+1 WHERE task_id=$1 AND status='running' RETURNING *`, [taskId, dispatch.dispatchId, dispatch.expiresAt, iso(nowAt)]);
    return result.rowCount ? { task: mapTask(result.rows[0]) } : taskError('长任务不处于可派发状态。', 'AGENT_LONG_TASK_NOT_RUNNING');
  }

  async failTask(taskId, reason, nowAt = this.clock()) {
    const result = await this.pool.query(`UPDATE agent_long_tasks SET status='failed',phase='failed',progress=100,lease_expires_at=NULL,result_json=$2::jsonb,updated_at=$3,version=version+1 WHERE task_id=$1 AND status IN ('queued','paused','running') RETURNING *`, [taskId, JSON.stringify({ code: 'AGENT_LONG_TASK_FAILED', message: String(reason || '长任务执行失败。').slice(0, 300) }), iso(nowAt)]);
    return result.rowCount ? { task: mapTask(result.rows[0]) } : null;
  }

  async completeByRun(runId, succeeded, resultValue = null, nowAt = this.clock()) {
    const result = await this.pool.query(`
      UPDATE agent_long_tasks SET status=$2,phase=$3,progress=100,lease_expires_at=NULL,result_json=$4::jsonb,updated_at=$5,version=version+1
      WHERE task_id=(SELECT task_id FROM agent_long_tasks WHERE run_id=$1 AND status='running' ORDER BY updated_at DESC LIMIT 1) RETURNING *
    `, [runId, succeeded ? 'succeeded' : 'failed', succeeded ? 'completed' : 'failed', resultValue === null ? null : JSON.stringify(resultValue), iso(nowAt)]);
    return result.rowCount ? { task: mapTask(result.rows[0]) } : null;
  }

  async enqueue(input) {
    const identity = input.identityScope || {};
    if (![identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId].every((value) => String(value || '').trim())) throw new Error('Authenticated tenant, subject, session, and device are required.');
    const client = await this.pool.connect();
    const nowAt = Number(input.nowAt ?? this.clock());
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(input.runId)]);
      const existing = await client.query("SELECT * FROM agent_long_tasks WHERE run_id = $1 AND status IN ('queued', 'paused', 'running') LIMIT 1", [String(input.runId)]);
      if (existing.rowCount) {
        await client.query('COMMIT');
        return { task: mapTask(existing.rows[0]), reused: true };
      }
      const taskId = `runtime-task-${randomUUID()}`;
      const result = await client.query(`
        INSERT INTO agent_long_tasks(task_id, task_type, run_id, command_id, conversation_id, role_id, tenant_id, subject_id, session_id, device_id, status, phase, attempt, progress, deadline_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued','waiting_for_worker',0,0,$11,$12,$12)
        RETURNING *
      `, [taskId, String(input.type || 'desktop_execution').slice(0, 80), String(input.runId).slice(0, 120), String(input.commandId).slice(0, 160), input.conversationId ? String(input.conversationId).slice(0, 160) : null, String(input.roleId).slice(0, 120), String(identity.tenantId).slice(0, 120), String(identity.subjectId).slice(0, 180), String(identity.sessionId).slice(0, 180), String(identity.deviceId).slice(0, 180), iso(nowAt + bounded(input.timeoutMs, 600_000, 60_000, 3_600_000)), iso(nowAt)]);
      await client.query('COMMIT');
      return { task: mapTask(result.rows[0]), reused: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }

  async recordHeartbeat({ workerId: suppliedWorkerId, mode = 'timeout_sweeper', intervalMs = 5_000, nowAt = this.clock() }) {
    const workerId = workerIdOf(suppliedWorkerId);
    const workerMode = ['timeout_sweeper', 'run_transition_consumer'].includes(mode) ? mode : 'timeout_sweeper';
    const interval = bounded(intervalMs, 5_000, 500, 60_000);
    const expiresAt = iso(Number(nowAt) + bounded(interval * 4, 15_000, 15_000, 300_000));
    const result = await this.pool.query(`
      INSERT INTO agent_runtime_worker_heartbeats(worker_id, mode, status, interval_ms, last_seen_at, expires_at)
      VALUES ($1,$2,'online',$3,$4,$5)
      ON CONFLICT (worker_id) DO UPDATE SET mode=EXCLUDED.mode, status='online', interval_ms=EXCLUDED.interval_ms, last_seen_at=EXCLUDED.last_seen_at, expires_at=EXCLUDED.expires_at
      RETURNING *
    `, [workerId, workerMode, interval, iso(nowAt), expiresAt]);
    return result.rows[0];
  }

  async acquireLease({ workerId: suppliedWorkerId, leaseMs = 15_000, nowAt = this.clock() }) {
    const workerId = workerIdOf(suppliedWorkerId);
    const nowIso = iso(nowAt);
    const expiresAt = iso(Number(nowAt) + bounded(leaseMs, 15_000, 5_000, 300_000));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO agent_runtime_worker_leases(lease_name, worker_id, acquired_at, renewed_at, expires_at, version)
        VALUES ('sweeper-lease',$1,$2,$2,$3,1) ON CONFLICT (lease_name) DO NOTHING
      `, [workerId, nowIso, expiresAt]);
      const current = await client.query("SELECT * FROM agent_runtime_worker_leases WHERE lease_name='sweeper-lease' FOR UPDATE");
      const lease = current.rows[0];
      if (lease.worker_id !== workerId && Date.parse(lease.expires_at) > Number(nowAt)) {
        await client.query('ROLLBACK');
        return { acquired: false, lease };
      }
      const result = await client.query(`
        UPDATE agent_runtime_worker_leases SET worker_id=$1,
          acquired_at=CASE WHEN worker_id=$1 THEN acquired_at ELSE $2 END,
          renewed_at=$2, expires_at=$3, version=version+1
        WHERE lease_name='sweeper-lease' RETURNING *
      `, [workerId, nowIso, expiresAt]);
      await client.query('COMMIT');
      return { acquired: true, lease: result.rows[0] };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }

  async expireDueTasks({ nowAt = this.clock(), limit = 100 } = {}) {
    const client = await this.pool.connect();
    const nowIso = iso(nowAt);
    try {
      await client.query('BEGIN');
      const due = await client.query(`
        SELECT * FROM agent_long_tasks
        WHERE (status='queued' AND deadline_at <= $1)
           OR (status='paused' AND pause_expires_at <= $1)
           OR (status='running' AND lease_expires_at <= $1)
        ORDER BY updated_at ASC LIMIT $2
        FOR UPDATE SKIP LOCKED
      `, [nowIso, bounded(limit, 100, 1, 500)]);
      const expired = [];
      for (const row of due.rows) {
        const phase = row.status === 'running' ? 'worker_lease_expired' : 'deadline_expired';
        const updated = await client.query(`
          UPDATE agent_long_tasks SET status='timed_out', phase=$2, progress=100, lease_expires_at=NULL,
            result_json=$3::jsonb, updated_at=$4, version=version+1
          WHERE task_id=$1 AND status=$5 RETURNING *
        `, [row.task_id, phase, JSON.stringify({ code: 'AGENT_LONG_TASK_TIMED_OUT', message: '任务超过允许时间，已停止继续派发。' }), nowIso, row.status]);
        if (!updated.rowCount) continue;
        await client.query(`
          INSERT INTO agent_runtime_run_transitions(transition_id, task_id, run_id, transition_type, payload_json, created_at)
          VALUES ($1,$2,$3,'execution_timed_out',$4::jsonb,$5)
        `, [`run-transition-${randomUUID()}`, row.task_id, row.run_id, JSON.stringify({ status: 'execution_timed_out', reason: phase, retryAllowed: false }), nowIso]);
        expired.push(mapTask(updated.rows[0]));
      }
      await client.query('COMMIT');
      return expired;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }

  async claimRunTransitions({ workerId: suppliedWorkerId, limit = 100, leaseMs = 60_000, nowAt = this.clock() }) {
    const workerId = workerIdOf(suppliedWorkerId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(`
        SELECT t.*, q.role_id, q.tenant_id, q.subject_id, q.session_id, q.device_id, q.attempt, q.dispatch_id
        FROM agent_runtime_run_transitions t JOIN agent_long_tasks q ON q.task_id=t.task_id
        WHERE t.consumed_at IS NULL AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= $1)
        ORDER BY t.created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
      `, [iso(nowAt), bounded(limit, 100, 1, 500)]);
      const claimed = [];
      for (const row of rows.rows) {
        const updated = await client.query(`UPDATE agent_runtime_run_transitions SET claimed_by=$2,lease_expires_at=$3,attempts=attempts+1 WHERE transition_id=$1 AND consumed_at IS NULL RETURNING *`, [row.transition_id, workerId, iso(Number(nowAt) + bounded(leaseMs, 60_000, 10_000, 300_000))]);
        if (updated.rowCount) claimed.push({
          id: row.transition_id, taskId: row.task_id, runId: row.run_id, type: row.transition_type, payload: row.payload_json,
          roleId: row.role_id, identityScope: { tenantId: row.tenant_id, subjectId: row.subject_id, sessionId: row.session_id, deviceId: row.device_id },
          attempt: Number(row.attempt), dispatchId: row.dispatch_id, deliveryAttempt: Number(updated.rows[0].attempts)
        });
      }
      await client.query('COMMIT');
      return claimed;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* preserve original error */ } throw error; } finally { client.release(); }
  }

  async completeRunTransition({ transitionId, workerId, nowAt = this.clock() }) {
    const result = await this.pool.query(`UPDATE agent_runtime_run_transitions SET consumed_at=$3,lease_expires_at=NULL WHERE transition_id=$1 AND claimed_by=$2 AND consumed_at IS NULL RETURNING transition_id`, [transitionId, workerId, iso(nowAt)]);
    return result.rowCount > 0;
  }

  async releaseRunTransition({ transitionId, workerId }) {
    const result = await this.pool.query(`UPDATE agent_runtime_run_transitions SET claimed_by=NULL,lease_expires_at=NULL WHERE transition_id=$1 AND claimed_by=$2 AND consumed_at IS NULL`, [transitionId, workerId]);
    return result.rowCount > 0;
  }

  async getMetrics({ nowAt = this.clock(), identityScope = null, roleIds = null } = {}) {
    const identity = identityScope ? normalizeIdentity(identityScope) : null;
    const roles = roleIds ? [...new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean).map(String))] : null;
    const result = await this.pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('queued','paused','running'))::int AS queue_depth,
        COUNT(*) FILTER (WHERE status='queued')::int AS queued,
        COUNT(*) FILTER (WHERE status='paused')::int AS paused,
        COUNT(*) FILTER (WHERE status='running')::int AS running,
        COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status='timed_out')::int AS timed_out,
        COUNT(*) FILTER (WHERE status='timed_out' AND updated_at >= $1::timestamptz - interval '1 hour')::int AS timed_out_last_hour,
        COUNT(*) FILTER (WHERE status='failed' AND updated_at >= $1::timestamptz - interval '1 hour')::int AS failed_last_hour,
        COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(created_at) FILTER (WHERE status='queued'))) * 1000, 0)::bigint AS oldest_queued_age_ms
      FROM agent_long_tasks
      WHERE ($2::text IS NULL OR (tenant_id=$2 AND subject_id=$3)) AND ($4::text[] IS NULL OR role_id=ANY($4::text[]))
    `, [iso(nowAt), identity?.tenantId || null, identity?.subjectId || null, roles]);
    const worker = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE h.expires_at > $1)::int AS active_instances,
        MAX(h.last_seen_at) AS last_heartbeat_at,
        MAX(CASE WHEN l.expires_at > $1 AND h.worker_id=l.worker_id AND h.expires_at > $1 THEN l.worker_id END) AS leader_worker_id,
        MAX(CASE WHEN l.expires_at > $1 AND h.worker_id=l.worker_id AND h.expires_at > $1 THEN l.expires_at END) AS lease_expires_at
      FROM agent_runtime_worker_heartbeats h LEFT JOIN agent_runtime_worker_leases l ON l.lease_name='sweeper-lease'
      WHERE h.mode='timeout_sweeper'
    `, [iso(nowAt)]);
    const row = result.rows[0];
    const workerRow = worker.rows[0] || {};
    return {
      total: Number(row.total), queueDepth: Number(row.queue_depth), queued: Number(row.queued), paused: Number(row.paused), running: Number(row.running),
      succeeded: Number(row.succeeded), failed: Number(row.failed), cancelled: Number(row.cancelled), timedOut: Number(row.timed_out),
      timedOutLastHour: Number(row.timed_out_last_hour), failedLastHour: Number(row.failed_last_hour), oldestQueuedAgeMs: Number(row.oldest_queued_age_ms),
      worker: { status: workerRow.leader_worker_id ? 'healthy' : Number(workerRow.active_instances) ? 'standby_only' : 'offline', activeInstances: Number(workerRow.active_instances || 0), leaderWorkerId: workerRow.leader_worker_id || null, leaseExpiresAt: workerRow.lease_expires_at ? new Date(workerRow.lease_expires_at).toISOString() : null, lastHeartbeatAt: workerRow.last_heartbeat_at ? new Date(workerRow.last_heartbeat_at).toISOString() : null }
    };
  }

  async runMaintenanceCycle({ workerId, intervalMs, leaseMs, nowAt = this.clock() }) {
    const heartbeat = await this.recordHeartbeat({ workerId, intervalMs, nowAt });
    const leadership = await this.acquireLease({ workerId, leaseMs, nowAt });
    if (!leadership.acquired) return { workerId, leader: false, expired: 0, heartbeat, metrics: await this.getMetrics({ nowAt }) };
    const expiredTasks = await this.expireDueTasks({ nowAt });
    return { workerId, leader: true, expired: expiredTasks.length, expiredTaskIds: expiredTasks.map((task) => task.id), heartbeat, lease: leadership.lease, metrics: await this.getMetrics({ nowAt }) };
  }

  async probe() {
    try { await this.pool.query('SELECT 1 AS ready'); return { ready: true }; } catch { return { ready: false }; }
  }

  async getTransitionConsumerStatus({ nowAt = this.clock() } = {}) {
    const result = await this.pool.query(`SELECT COUNT(*) FILTER (WHERE mode='run_transition_consumer' AND expires_at>$1)::int AS active_instances, MAX(last_seen_at) FILTER (WHERE mode='run_transition_consumer') AS last_heartbeat_at FROM agent_runtime_worker_heartbeats`, [iso(nowAt)]);
    return { ready: Number(result.rows[0]?.active_instances || 0) > 0, activeInstances: Number(result.rows[0]?.active_instances || 0), lastHeartbeatAt: result.rows[0]?.last_heartbeat_at ? new Date(result.rows[0].last_heartbeat_at).toISOString() : null };
  }

  async close() { if (typeof this.pool.end === 'function') await this.pool.end(); }
}

export async function createPostgresAgentLongTaskRepository({ connectionString = process.env.RUNTIME_POSTGRES_URL, pool, clock } = {}) {
  let resolvedPool = pool;
  if (!resolvedPool) {
    if (!String(connectionString || '').trim()) throw new Error('RUNTIME_POSTGRES_URL is required for the PostgreSQL agent runtime worker.');
    const connectionUrl = new URL(connectionString);
    const sslMode = String(process.env.RUNTIME_POSTGRES_SSL_MODE || connectionUrl.searchParams.get('sslmode') || '').toLowerCase();
    if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('RUNTIME_POSTGRES_URL must use postgresql://.');
    if (process.env.NODE_ENV === 'production' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) throw new Error('Production PostgreSQL agent runtime requires sslmode=require, verify-ca, or verify-full.');
    const { Pool } = await import('pg');
    resolvedPool = new Pool({ connectionString, max: Number(process.env.RUNTIME_POSTGRES_POOL_MAX || 10), statement_timeout: Number(process.env.RUNTIME_POSTGRES_STATEMENT_TIMEOUT_MS || 5_000), application_name: 'healthcare-ai-agent-runtime-worker' });
  }
  const repository = new PostgresAgentLongTaskRepository({ pool: resolvedPool, clock });
  await repository.initialize();
  return repository;
}
