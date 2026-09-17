import { getEffectiveAccess, selectEffectiveRoleForPermission } from '../services/access-control-service.js';
import { runWithIAMStoreContext } from '../services/iam-store.js';
import { runWithSemanticTenant } from '../services/semantic-tenant-context.js';
import { isPublicPath, requiredReadPagePermissions } from './route-security.js';
import { authorizeTenantRuntime, tenantRuntimeFeature } from '../services/tenant-runtime-control-service.js';

export async function dispatchAuthorizedRoutes(context, routeHandlers, handleIdentityRoutes) {
  const { req, res, url, role, identity, agentIdentity, send } = context;
  // Login handlers verify external identity before choosing an IAM tenant.
  // In particular a public DingTalk login must not be pinned to Demo first.
  if (isPublicPath(url.pathname) && await handleIdentityRoutes(context)) return;
  return runWithIAMStoreContext(async () => {
    const admission = !isPublicPath(url.pathname)
      ? await authorizeTenantRuntime(agentIdentity, { feature: tenantRuntimeFeature(url.pathname), consume: true }) : { managed: false };
    const effectiveAccess = getEffectiveAccess(role, agentIdentity);
    const requiredPages = req.method === 'GET' ? requiredReadPagePermissions(url.pathname) : null;
    if (requiredPages && !requiredPages.some(permission => effectiveAccess.pagePermissionIds.includes(permission))) {
      return send(res, 403, {
        message: `当前有效权限未授予页面访问：${requiredPages.join(' / ')}。`,
        code: 'PAGE_PERMISSION_DENIED', requiredPagePermissionIds: requiredPages
      });
    }
    let reply;
    const authorized = {
      ...context, effectiveAccess,
      ...(admission.managed ? { send: (_response, status, payload) => { reply = { status, payload }; } } : {}),
      selectActionRole: permission => selectEffectiveRoleForPermission(role, permission, agentIdentity),
      denyButton: permission => send(res, 403, {
        message: `当前有效权限未授予按钮操作：${permission}。`, code: 'BUTTON_PERMISSION_DENIED'
      })
    };
    const dispatch = async () => {
      for (const handler of routeHandlers) if (await handler(authorized)) return;
      return send(res, 404, { message: '未找到接口。' });
    };
    const result = await (identity.error ? dispatch() : runWithSemanticTenant(agentIdentity, dispatch));
    if (admission.managed && reply) {
      await authorizeTenantRuntime(agentIdentity, { feature: tenantRuntimeFeature(url.pathname), expectedRevision: admission.revision });
      return send(res, reply.status, reply.payload);
    }
    return result;
  }, agentIdentity.tenantId);
}
