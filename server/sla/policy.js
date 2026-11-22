import { requireThat } from '../validation.js';

export async function policyFor(unit, service) {
  const policy = await unit.policies.one({ _id: service.policy || unit.settings.defaultPolicyId });
  requireThat(policy, 'Configure an SLA policy for this service or set a default policy.', 409);
  return policy;
}
